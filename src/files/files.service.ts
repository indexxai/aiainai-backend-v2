import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import sharp from 'sharp';
import { AppError } from '../common/api-error.js';
import { CreditsService } from '../credits/credits.service.js';
import { scoped } from '../database/scoped.js';
import { Upload, type UploadKind } from '../database/schemas/upload.schema.js';
import { ModelsService } from '../models/models.service.js';
import { StorageService } from '../storage/storage.service.js';
import { detect, extract, MAX_UPLOAD_BYTES, UnsupportedFile } from './extract.js';
import { Project } from '../database/schemas/project.schema.js';
import type { AttachmentDto, FileDto, FileListDto } from './files.dto.js';

type UploadLean = Upload & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date; credits?: number };

export interface FilesActor {
  userId: string;
  workspaceId: Types.ObjectId;
}

/** Most files on one message. */
export const MAX_FILES_PER_MESSAGE = 5;
/** Text from a message's files that goes to the model in one turn (about 30,000 words). */
export const MAX_ATTACHED_CHARS = 180_000;
const PAGE = 30;
const IMAGE_CREDITS = 1;

const notFound = () => new AppError('not_found', 'We can’t find that file.', HttpStatus.NOT_FOUND);
const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  return new Types.ObjectId(id);
};

/**
 * Files people give Jack: stored once, with their text extracted on upload, then attached to
 * chat messages by id. Images are described by a small vision model (1 credit) so every model,
 * even ones that can't see pictures, can work with them.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectModel(Upload.name) private readonly uploads: Model<Upload>,
    @InjectModel(Project.name) private readonly projects: Model<Project>,
    private readonly storage: StorageService,
    private readonly models: ModelsService,
    private readonly credits: CreditsService,
  ) {}

  async upload(
    actor: FilesActor,
    input: { name: string; contentType: string; bytes: Buffer; projectId?: string },
  ): Promise<FileDto> {
    const name = cleanName(input.name);
    let projectId: Types.ObjectId | null = null;
    if (input.projectId) {
      const p = Types.ObjectId.isValid(input.projectId)
        ? await this.projects
            .findOne(scoped<Project>(actor.workspaceId, { _id: new Types.ObjectId(input.projectId) }), {
              _id: 1,
            })
            .lean<{ _id: Types.ObjectId }>()
        : null;
      if (!p) throw new AppError('not_found', 'We can’t find that project.', HttpStatus.NOT_FOUND);
      projectId = p._id;
    }
    if (!input.bytes.length) throw new AppError('validation_failed', `${name} is empty.`, 422);
    if (input.bytes.length > MAX_UPLOAD_BYTES)
      throw new AppError('payload_too_large', `${name} is too large. Use files under 20 MB.`, 413);
    let found: { kind: UploadKind; type: string };
    try {
      found = detect(name, input.contentType, input.bytes);
    } catch (e) {
      if (e instanceof UnsupportedFile) throw new AppError('validation_failed', e.message, 422);
      throw e;
    }

    let read: { text: string; truncated: boolean; pages?: number; note?: string; credits?: number };
    try {
      read =
        found.kind === 'image'
          ? await this.describe(actor, input.bytes)
          : await extract(found.kind, found.type, input.bytes);
    } catch (e) {
      this.logger.warn({ err: e instanceof Error ? e.message : e, kind: found.kind }, 'could not read file');
      throw new AppError(
        'validation_failed',
        `${name} couldn’t be opened. It may be damaged or password-protected.`,
        422,
      );
    }

    const storageKey = `uploads/${actor.workspaceId.toHexString()}/${randomUUID()}`;
    await this.storage.put(storageKey, input.bytes, found.type);
    const doc = await this.uploads.create({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      name,
      contentType: found.type,
      kind: found.kind,
      bytes: input.bytes.length,
      storageKey,
      text: read.text,
      truncated: read.truncated,
      pages: read.pages,
      note: read.note ?? null,
      credits: read.credits ?? 0,
      projectId,
    });
    return toDto(doc.toObject() as unknown as UploadLean);
  }

  async list(actor: FilesActor, q: { q?: string; cursor?: string }): Promise<FileListDto> {
    const filter: Record<string, unknown> = {};
    if (q.q?.trim()) filter.name = { $regex: escapeRegex(q.q.trim()), $options: 'i' };
    if (q.cursor && Types.ObjectId.isValid(q.cursor)) filter._id = { $lt: new Types.ObjectId(q.cursor) };
    const rows = await this.uploads
      .find(scoped<Upload>(actor.workspaceId, filter), { text: 0 })
      .sort({ _id: -1 })
      .limit(PAGE + 1)
      .lean<UploadLean[]>();
    const items = rows.slice(0, PAGE).map(toDto);
    return { items, nextCursor: rows.length > PAGE ? items.at(-1)!.id : null };
  }

  async get(actor: FilesActor, id: string): Promise<FileDto> {
    return toDto(await this.find(actor, id));
  }

  async download(
    actor: FilesActor,
    id: string,
  ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    const f = await this.find(actor, id);
    const stored = await this.storage.get(f.storageKey);
    if (!stored) throw notFound();
    return { name: f.name, contentType: f.contentType, bytes: stored.bytes };
  }

  /** Removes the file for good (its bytes too). Messages it was attached to keep its name. */
  async remove(actor: FilesActor, id: string): Promise<void> {
    const f = await this.find(actor, id);
    await this.uploads.updateOne({ _id: f._id }, { $set: { deletedAt: new Date(), text: '' } });
    await this.storage.delete(f.storageKey).catch(() => undefined);
  }

  /** Files for a new message: this workspace's, in the order given, each once. */
  async forMessage(actor: FilesActor, ids: string[], chatId: Types.ObjectId): Promise<UploadLean[]> {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_FILES_PER_MESSAGE)
      throw new AppError(
        'validation_failed',
        `Attach up to ${MAX_FILES_PER_MESSAGE} files to a message.`,
        422,
      );
    const rows = await Promise.all(unique.map((id) => this.find(actor, id)));
    // Remember where a file was first used, for the Files page.
    await this.uploads.updateMany(
      { _id: { $in: rows.filter((r) => !r.chatId).map((r) => r._id) } },
      { $set: { chatId } },
    );
    return rows;
  }

  /** The text of attached files, for building what the model reads (deleted files are skipped). */
  async texts(workspaceId: Types.ObjectId, ids: Types.ObjectId[]): Promise<Map<string, UploadLean>> {
    if (!ids.length) return new Map();
    const rows = await this.uploads
      .find(scoped<Upload>(workspaceId, { _id: { $in: ids } }))
      .lean<UploadLean[]>();
    return new Map(rows.map((r) => [r._id.toHexString(), r]));
  }

  /** A project's files (newest first), for chats in that project. */
  async projectFiles(workspaceId: Types.ObjectId, projectId: Types.ObjectId): Promise<UploadLean[]> {
    return this.uploads
      .find(scoped<Upload>(workspaceId, { projectId }), { name: 1 })
      .sort({ _id: -1 })
      .limit(40)
      .lean<UploadLean[]>();
  }

  private async find(actor: FilesActor, id: string): Promise<UploadLean> {
    const f = await this.uploads
      .findOne(scoped<Upload>(actor.workspaceId, { _id: oid(id) }))
      .lean<UploadLean>();
    if (!f) throw notFound();
    return f;
  }

  /** What's in a picture, and any text in it, so Jack can use it with any model. */
  private async describe(
    actor: FilesActor,
    bytes: Buffer,
  ): Promise<{ text: string; truncated: boolean; note?: string; credits?: number }> {
    if (this.models.demo)
      return {
        text: 'Sample description: a photo on a desk with a laptop and a cup of coffee. Text in the image: “Q3 plan”.',
        truncated: false,
        credits: IMAGE_CREDITS,
      };
    const model = this.models.providers.visionModel();
    if (!model)
      return {
        text: '',
        truncated: false,
        note: 'Images can’t be read yet on this setup. The file is kept.',
      };
    const key = `file-image:${randomUUID()}`;
    let holdId: string;
    try {
      ({ holdId } = await this.credits.hold({
        workspaceId: actor.workspaceId,
        amount: IMAGE_CREDITS,
        key,
        reason: 'Reading an image',
        ref: { kind: 'upload', id: key },
      }));
    } catch (e) {
      if (e instanceof AppError && e.code === 'insufficient_credits')
        return {
          text: '',
          truncated: false,
          note: 'Not enough credits to read this image. The file is kept.',
        };
      throw e;
    }
    try {
      const small = await sharp(bytes, { animated: false })
        .rotate()
        .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const r = await generateText({
        model,
        maxOutputTokens: 900,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image for someone who cannot see it: what it shows, in a few sentences. Then copy any text in it exactly, under "Text in the image:". Keep it short and factual.',
              },
              { type: 'image', image: small, mediaType: 'image/jpeg' },
            ],
          },
        ],
      });
      await this.credits.settle({
        workspaceId: actor.workspaceId,
        holdId,
        actual: IMAGE_CREDITS,
        reason: 'Reading an image',
      });
      return { text: r.text.trim(), truncated: false, credits: IMAGE_CREDITS };
    } catch (e) {
      await this.credits.settle({
        workspaceId: actor.workspaceId,
        holdId,
        actual: 0,
        reason: 'Reading an image',
      });
      this.logger.warn({ err: e instanceof Error ? e.message : e }, 'image description failed');
      return {
        text: '',
        truncated: false,
        note: 'This image couldn’t be read right now. The file is kept.',
      };
    }
  }
}

export function toDto(f: UploadLean): FileDto {
  return {
    id: f._id.toHexString(),
    name: f.name,
    kind: f.kind,
    contentType: f.contentType,
    bytes: f.bytes,
    pages: f.pages ?? undefined,
    chars: f.text?.length ?? 0,
    truncated: !!f.truncated,
    note: f.note ?? null,
    chatId: f.chatId ? f.chatId.toHexString() : null,
    projectId: f.projectId ? f.projectId.toHexString() : null,
    credits: f.credits ?? 0,
    createdAt: new Date(f.createdAt).toISOString(),
  };
}

export const toAttachment = (a: {
  fileId: Types.ObjectId;
  name: string;
  kind?: UploadKind;
}): AttachmentDto => ({
  id: a.fileId.toHexString(),
  name: a.name,
  kind: a.kind ?? 'text',
});

/** File names are shown and used in downloads: no paths, control characters or very long names. */
export function cleanName(name: string): string {
  const base = name
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim();
  return (base || 'file').slice(0, 200);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
