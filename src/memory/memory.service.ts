import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { Memory, type MemoryGroup } from '../database/schemas/memory.schema.js';
import { Workspace, type Plan } from '../database/schemas/workspace.schema.js';
import { GatewayService } from '../gateway/gateway.service.js';
import {
  cleanText,
  LEARN_MAX_TOKENS,
  LEARN_SYSTEM,
  learnSchema,
  MAX_MEMORIES,
  memoryKey,
  PROMPT_MEMORIES,
} from './memory.logic.js';
import type { MemoryDto, MemoryListDto } from './memory.dto.js';

export interface MemoryActor {
  userId: string;
  workspaceId: Types.ObjectId;
  plan: Plan;
}

type Lean = Memory & { _id: Types.ObjectId; createdAt: Date };

const notFound = () => new AppError('not_found', 'We can’t find that memory.', HttpStatus.NOT_FOUND);
const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  return new Types.ObjectId(id);
};

/**
 * What Jack knows, per space (v2 Memory). People see and edit everything; forgetting deletes
 * for good. Jack uses the list in every answer and, when allowed, learns new facts from messages.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @InjectModel(Memory.name) private readonly memories: Model<Memory>,
    @InjectModel(Workspace.name) private readonly workspaces: Model<Workspace>,
    private readonly gateway: GatewayService,
  ) {}

  async list(actor: MemoryActor): Promise<MemoryListDto> {
    const [rows, ws] = await Promise.all([
      this.memories
        .find({ workspaceId: actor.workspaceId })
        .sort({ createdAt: -1 })
        .limit(MAX_MEMORIES)
        .lean<Lean[]>(),
      this.workspaces
        .findById(actor.workspaceId, { memoryEnabled: 1 })
        .lean<Pick<Workspace, 'memoryEnabled'>>(),
    ]);
    return { enabled: ws?.memoryEnabled !== false, items: rows.map(toDto) };
  }

  async add(actor: MemoryActor, input: { text: string; group: MemoryGroup }): Promise<MemoryDto> {
    const text = cleanText(input.text);
    if (!text) throw new AppError('validation_failed', 'Write what to remember.', 422);
    const key = memoryKey(text);
    const existing = await this.memories.findOne({ workspaceId: actor.workspaceId, key }).lean<Lean>();
    if (existing) return toDto(existing);
    if ((await this.memories.countDocuments({ workspaceId: actor.workspaceId })) >= MAX_MEMORIES)
      throw new AppError(
        'conflict',
        `A space can keep ${MAX_MEMORIES} memories. Forget some to add more.`,
        HttpStatus.CONFLICT,
      );
    const row = await this.memories.create({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      text,
      group: input.group,
      source: 'you',
      key,
    });
    return toDto(row.toObject() as unknown as Lean);
  }

  async update(
    actor: MemoryActor,
    id: string,
    input: { text?: string; group?: MemoryGroup },
  ): Promise<MemoryDto> {
    const $set: Partial<Memory> = {};
    if (input.text !== undefined) {
      const text = cleanText(input.text);
      if (!text) throw new AppError('validation_failed', 'Write what to remember.', 422);
      $set.text = text;
      $set.key = memoryKey(text);
    }
    if (input.group) $set.group = input.group;
    try {
      const row = await this.memories
        .findOneAndUpdate({ _id: oid(id), workspaceId: actor.workspaceId }, { $set }, { new: true })
        .lean<Lean>();
      if (!row) throw notFound();
      return toDto(row);
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new AppError('conflict', 'That’s already remembered.', HttpStatus.CONFLICT);
      throw err;
    }
  }

  /** Gone for good, and from every answer from now on. */
  async forget(actor: MemoryActor, id: string): Promise<void> {
    const res = await this.memories.deleteOne({ _id: oid(id), workspaceId: actor.workspaceId });
    if (!res.deletedCount) throw notFound();
  }

  async setEnabled(actor: MemoryActor, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.workspaces.updateOne({ _id: actor.workspaceId }, { $set: { memoryEnabled: enabled } });
    return { enabled };
  }

  /** The newest memories, for Jack's instructions. */
  async forPrompt(workspaceId: Types.ObjectId): Promise<{ text: string; group: MemoryGroup }[]> {
    return this.memories
      .find({ workspaceId }, { text: 1, group: 1 })
      .sort({ createdAt: -1 })
      .limit(PROMPT_MEMORIES)
      .lean<{ text: string; group: MemoryGroup }[]>();
  }

  /**
   * After an answer: save up to two lasting facts from the person's message, if this space lets
   * Jack remember new things. Free, and never fails the answer.
   */
  async learn(
    actor: MemoryActor,
    input: { text: string; chatId: Types.ObjectId; key: string; model: string },
  ): Promise<MemoryDto[]> {
    try {
      const ws = await this.workspaces
        .findById(actor.workspaceId, { memoryEnabled: 1 })
        .lean<Pick<Workspace, 'memoryEnabled'>>();
      if (ws?.memoryEnabled === false) return [];
      const known = (await this.forPrompt(actor.workspaceId)).map((m) => m.text);
      const result = await this.gateway.object({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        plan: actor.plan,
        tool: 'memory',
        model: input.model,
        system: LEARN_SYSTEM(known),
        messages: [{ role: 'user', content: input.text.slice(0, 4000) }],
        key: `memory:${input.key}`,
        ref: { kind: 'memory', id: input.key },
        schema: learnSchema,
        price: { credits: 0 },
        maxOutputTokens: LEARN_MAX_TOKENS,
      });
      const saved: MemoryDto[] = [];
      for (const m of result.object.memories) {
        const text = cleanText(m.text);
        const key = memoryKey(text);
        if (!text || known.some((k) => memoryKey(k) === key)) continue;
        if ((await this.memories.countDocuments({ workspaceId: actor.workspaceId })) >= MAX_MEMORIES) break;
        try {
          const row = await this.memories.create({
            workspaceId: actor.workspaceId,
            createdBy: actor.userId,
            text,
            group: m.group,
            source: 'jack',
            chatId: input.chatId,
            key,
          });
          saved.push(toDto(row.toObject() as unknown as Lean));
        } catch (err) {
          if ((err as { code?: number }).code !== 11000) throw err;
        }
      }
      return saved;
    } catch (err) {
      this.logger.warn({ err }, 'Learning from a message failed');
      return [];
    }
  }
}

function toDto(m: Lean): MemoryDto {
  return {
    id: m._id.toHexString(),
    text: m.text,
    group: m.group,
    source: m.source,
    chatId: m.chatId ? String(m.chatId) : null,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}
