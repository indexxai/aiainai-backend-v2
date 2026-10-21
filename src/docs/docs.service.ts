import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../common/api-error.js';
import { liveRuns, runKey } from '../common/live-runs.js';
import { DocsVersionsService } from './docs-versions.service.js';
import { DocumentRecord } from '../database/schemas/document.schema.js';
import type { Plan } from '../database/schemas/workspace.schema.js';
import { scoped } from '../database/scoped.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { AUTO } from '../models/models.logic.js';
import { ModelsService } from '../models/models.service.js';
import {
  assistantMessages,
  assistantSchema,
  cleanRewrite,
  editMessages,
  editSchema,
  type EditAction,
} from './docs-ai.logic.js';
import type {
  AssistantReplyDto,
  DocDto,
  DocListDto,
  DocSummaryDto,
  EditResultDto,
  EstimatesDto,
  OutlineDto,
} from './docs.dto.js';
import { ProjectContextService } from '../projects/project-context.service.js';
import {
  docCredits,
  keepCompleteSections,
  LENGTHS,
  OUTLINE_CREDITS,
  outlineMessages,
  plainText,
  sectionsDone,
  sectionsStarted,
  wordCount,
  writeMessages,
  type DocLength,
  type DocTone,
  type DocType,
  type Section,
} from './docs.logic.js';

export interface Actor {
  userId: string;
  workspaceId: Types.ObjectId;
  plan: Plan;
  /** Model makers switched off for this space (Business). */
  space?: 'personal' | 'business';
  /** Used to find documents shared with this person. */
  email?: string;
}

export type DocLean = DocumentRecord & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export type DocStreamEvent =
  | { event: 'ready'; data: { doc: DocDto } }
  | { event: 'model'; data: { model: string; modelName: string; auto: boolean; credits: number } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done' | 'error'; data: { doc: DocDto } };

export interface WriteRun {
  actor: Actor;
  doc: DocLean;
  /** Sections already written (Continue). */
  from: number;
  prefix: string;
  credits: number;
}

const outlineSchema = z.object({
  title: z.string().min(1).max(200),
  sections: z
    .array(z.object({ heading: z.string().min(1).max(120), note: z.string().max(120) }))
    .min(1)
    .max(12),
});

const STALE_MS = 3 * 60 * 1000;
/** How often writing progress is saved (for a page that comes back mid-way). */
const PROGRESS_SAVE_MS = 1000;
const PAGE = 30;

const notFound = () => new AppError('not_found', 'We can’t find that document.', HttpStatus.NOT_FOUND);
const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  return new Types.ObjectId(id);
};

/** AI Docs: outline → approve → write (streamed) → edit and autosave. */
@Injectable()
export class DocsService {
  private readonly logger = new Logger(DocsService.name);

  constructor(
    @InjectModel(DocumentRecord.name) private readonly docs: Model<DocumentRecord>,
    private readonly gateway: GatewayService,
    private readonly models: ModelsService,
    @Optional() private readonly versions?: DocsVersionsService,
    @Optional() private readonly projectContext?: ProjectContextService,
  ) {}

  /** The project's instructions and files when the document is in one (empty otherwise). */
  private project(workspaceId: Types.ObjectId, projectId?: Types.ObjectId | null) {
    return this.projectContext
      ? this.projectContext.forWriting(workspaceId, projectId)
      : Promise.resolve({ text: '', extraCredits: 0 });
  }

  private async projectId(actor: Actor, id?: string): Promise<Types.ObjectId | null> {
    if (!id) return null;
    if (!this.projectContext)
      throw new AppError('service_unavailable', 'Projects aren’t available right now.', 503);
    return this.projectContext.own(actor.workspaceId, id);
  }

  /** Step 1: a title and headings to check before anything is written. */
  async outline(
    actor: Actor,
    input: { brief: string; type: DocType; model?: string; projectId?: string },
  ): Promise<OutlineDto> {
    const m = outlineMessages(input.brief, input.type);
    const project = await this.project(actor.workspaceId, await this.projectId(actor, input.projectId));
    const key = new Types.ObjectId().toHexString();
    const result = await this.gateway.object({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      plan: actor.plan,
      tool: 'docs',
      model: input.model ?? AUTO,
      system: m.system + project.text,
      messages: [{ role: 'user', content: m.prompt }],
      extraCredits: project.extraCredits,
      key: `outline:${key}`,
      ref: { kind: 'doc-outline', id: key },
      schema: outlineSchema,
      price: { credits: OUTLINE_CREDITS },
      maxOutputTokens: 1500,
    });
    return { ...result.object, credits: result.credits };
  }

  /** What writing would cost for each length with this model (Auto: the model it would pick). */
  async estimates(actor: Actor, model = AUTO): Promise<EstimatesDto> {
    const { model: m } = await this.models.resolve(model, actor.plan, { chars: 1000 });
    const one = (l: DocLength) => ({ credits: docCredits(m.credits, l), words: LENGTHS[l].words });
    return { short: one('short'), medium: one('medium'), long: one('long') };
  }

  async create(
    actor: Actor,
    input: {
      title: string;
      type: DocType;
      brief?: string;
      sections: Section[];
      length?: DocLength;
      tone?: DocTone;
      model?: string;
      madeBy?: 'jack' | 'team';
      projectId?: string;
    },
  ): Promise<DocDto> {
    const model = input.model ?? AUTO;
    if (input.sections.length) await this.models.assertSelectable(model, actor.plan);
    const projectId = await this.projectId(actor, input.projectId);
    const doc = await this.docs.create({
      workspaceId: actor.workspaceId,
      projectId,
      createdBy: actor.userId,
      title: input.title.trim().slice(0, 200) || 'Untitled document',
      type: input.type,
      brief: input.brief ?? '',
      outline: input.sections,
      length: input.length ?? 'medium',
      tone: input.tone ?? 'professional',
      requestedModel: model,
      madeBy: input.madeBy,
      // A blank document is ready to edit; one with an outline waits to be written.
      status: input.sections.length ? 'draft' : 'ready',
    });
    return this.toDto(doc.toObject() as unknown as DocLean);
  }

  /** A finished document from Markdown (e.g. written by an AI Crews agent); opens straight in the editor. */
  async createFromMarkdown(
    actor: Actor,
    input: {
      title: string;
      markdown: string;
      type?: DocType;
      brief?: string;
      madeBy?: 'jack' | 'team';
      projectId?: string;
    },
  ): Promise<DocDto> {
    const projectId = await this.projectId(actor, input.projectId);
    const markdown = input.markdown.trim().slice(0, 200_000);
    const text = plainText(markdown);
    const doc = await this.docs.create({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      title: input.title.trim().slice(0, 200) || 'Untitled document',
      type: input.type ?? 'other',
      brief: (input.brief ?? '').slice(0, 4000),
      outline: [],
      markdown,
      text,
      wordCount: wordCount(text),
      status: 'ready',
      madeBy: input.madeBy,
      projectId,
    });
    return this.toDto(doc.toObject() as unknown as DocLean);
  }

  /** `mine`: this workspace's documents · `shared`: shared with me · `all`: both. */
  async list(
    actor: Actor,
    opts: { q?: string; cursor?: string; scope?: 'all' | 'mine' | 'shared' },
  ): Promise<DocListDto> {
    const scope = opts.scope ?? 'mine';
    const before = opts.cursor && Number.isFinite(Number(opts.cursor)) ? new Date(Number(opts.cursor)) : null;
    const q = opts.q?.trim();
    const email = actor.email?.toLowerCase();
    if (scope === 'shared' && !email) return { items: [], nextCursor: null };
    const mine = { workspaceId: actor.workspaceId };
    // Shared with me: documents in other workspaces that invited this email.
    const shared = { 'invites.email': email, workspaceId: { $ne: actor.workspaceId } };
    const who = scope === 'mine' || !email ? mine : scope === 'shared' ? shared : { $or: [mine, shared] };
    const rows = await this.docs
      .find(
        {
          ...who,
          deletedAt: null,
          ...(q && { title: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }),
          ...(before && { updatedAt: { $lt: before } }),
        },
        {
          workspaceId: 1,
          title: 1,
          type: 1,
          status: 1,
          wordCount: 1,
          updatedAt: 1,
          invites: 1,
          linkAccess: 1,
        },
      )
      .sort({ updatedAt: -1, _id: -1 })
      .limit(PAGE + 1)
      .lean<DocLean[]>();
    const page = rows.slice(0, PAGE);
    return {
      items: page.map((d) => {
        const own = String(d.workspaceId) === String(actor.workspaceId);
        return {
          ...toSummary(d),
          sharedWith: own ? (d.invites ?? []).length : 0,
          linkAccess: own ? (d.linkAccess ?? 'off') : 'off',
          sharedBy: own ? null : (d.invites?.find((i) => i.email === email)?.invitedBy ?? null),
        };
      }),
      nextCursor: rows.length > PAGE ? String(new Date(page[page.length - 1]!.updatedAt).getTime()) : null,
    };
  }

  /** Owners get the document to edit; people it was shared with get it read-only. */
  async get(actor: Actor, id: string): Promise<DocDto> {
    const { doc, own } = await this.readable(actor, id);
    if (own) return this.toDto(doc);
    const by = doc.invites.find((i) => i.email === actor.email!.toLowerCase())?.invitedBy ?? null;
    return { ...(await this.toDto(doc, 'view')), sharedBy: by };
  }

  /** The document if it's in this workspace (`own`) or was shared with this person. */
  async readable(actor: Actor, id: string): Promise<{ doc: DocLean; own: boolean }> {
    const own = await this.docs
      .findOne(scoped<DocumentRecord>(actor.workspaceId, { _id: oid(id) }))
      .lean<DocLean>();
    if (own) return { doc: own, own: true };
    const shared = actor.email
      ? await this.docs
          .findOne({ _id: oid(id), deletedAt: null, 'invites.email': actor.email.toLowerCase() })
          .lean<DocLean>()
      : null;
    if (!shared) throw notFound();
    return { doc: shared, own: false };
  }

  /** Autosave from the editor. */
  async update(
    actor: Actor,
    id: string,
    input: { title?: string; content?: Record<string, unknown>; text?: string; aiChange?: string },
  ) {
    const doc = await this.find(actor, id);
    if (doc.status === 'writing' && !isStale(doc))
      throw new AppError(
        'conflict',
        'Wait until the document has been written, then edit it.',
        HttpStatus.CONFLICT,
      );
    const $set: Partial<DocumentRecord> = {};
    if (input.title !== undefined) $set.title = input.title.trim().slice(0, 200) || 'Untitled document';
    if (input.content !== undefined) {
      $set.content = input.content;
      $set.text = (input.text ?? '').slice(0, 500_000);
      $set.wordCount = wordCount($set.text);
    }
    // Versions: keep the text being replaced every few minutes, and always around an AI change.
    if (input.content !== undefined) await this.versions?.beforeEdit(doc, actor.userId, !!input.aiChange);
    const updated = await this.docs
      .findOneAndUpdate({ _id: doc._id }, { $set }, { new: true })
      .lean<DocLean>();
    if (input.aiChange && input.content !== undefined)
      await this.versions?.snapshot(updated!, 'ai', `AI change: ${input.aiChange.slice(0, 80)}`, 'assistant');
    return this.toDto(updated!);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const doc = await this.find(actor, id);
    // A deleted document stops being written, so nothing more is charged for it.
    liveRuns.stop(runKey.doc(doc._id.toHexString()));
    await this.docs.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
  }

  /** Step 2: write the approved outline, or carry on after a stop or failure. */
  async prepareWrite(actor: Actor, id: string): Promise<WriteRun> {
    const doc = await this.find(actor, id);
    if (doc.status === 'writing' && !isStale(doc))
      throw new AppError('conflict', 'This document is already being written.', HttpStatus.CONFLICT);
    if (doc.status === 'ready' || !doc.outline.length)
      throw new AppError('conflict', 'This document has already been written.', HttpStatus.CONFLICT);
    if (doc.content)
      throw new AppError(
        'conflict',
        'This document has been edited; it can’t be rewritten.',
        HttpStatus.CONFLICT,
      );
    await this.models.assertSelectable(doc.requestedModel, actor.plan);

    const total = doc.outline.length;
    // Saved Markdown only ever holds complete sections.
    const from = doc.status === 'draft' ? 0 : Math.min(total, sectionsStarted(doc.markdown));
    const prefix = keepCompleteSections(doc.markdown, from);
    const { model } = await this.models.resolve(doc.requestedModel, actor.plan, { chars: 1000 });
    const full = docCredits(model.credits, doc.length);
    const credits = Math.max(1, Math.ceil((full * (total - from)) / total));

    const updated = await this.docs
      .findOneAndUpdate(
        { _id: doc._id, status: doc.status },
        { $set: { status: 'writing', markdown: prefix, error: null } },
        { new: true },
      )
      .lean<DocLean>();
    if (!updated)
      throw new AppError('conflict', 'This document is already being written.', HttpStatus.CONFLICT);
    return { actor, doc: updated, from, prefix, credits };
  }

  /**
   * Streams the writing and saves the result. Stopping part-way keeps the finished sections
   * and charges only for them; Continue writes the rest.
   */
  async *write(run: WriteRun, signal: AbortSignal, requestId?: string): AsyncGenerator<DocStreamEvent> {
    const { actor, doc, from } = run;
    const total = doc.outline.length;
    yield { event: 'ready', data: { doc: await this.toDto(doc) } };

    const m = writeMessages({
      title: doc.title,
      type: doc.type,
      brief: doc.brief,
      tone: doc.tone,
      length: doc.length,
      sections: doc.outline,
      from,
    });
    const project = await this.project(actor.workspaceId, doc.projectId);
    let text = '';
    let charged = 0;
    let finished = false;
    let model: { key: string; auto: boolean } | null = null;
    let error: { code: string; message: string } | null = null;
    const remaining = total - from;
    let savedAt = Date.now();
    try {
      for await (const e of this.gateway.stream({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        plan: actor.plan,
        tool: 'docs',
        model: doc.requestedModel,
        system: m.system + project.text,
        messages: [{ role: 'user', content: m.prompt }],
        extraCredits: project.extraCredits,
        key: `doc:${doc._id.toHexString()}:${new Types.ObjectId().toHexString()}`,
        ref: { kind: 'document', id: doc._id.toHexString() },
        requestId,
        abortSignal: signal,
        maxOutputTokens: Math.round(LENGTHS[doc.length].words * 3),
        price: {
          credits: run.credits,
          // Charge for the sections that were finished before Stop.
          onStop: (written) => (run.credits * sectionsDone(written, remaining, false)) / remaining,
        },
      })) {
        if (e.type === 'start') {
          model = { key: e.model.key, auto: e.auto };
          yield {
            event: 'model',
            data: { model: e.model.key, modelName: e.model.name, auto: e.auto, credits: e.credits },
          };
        } else if (e.type === 'text') {
          text += e.delta;
          yield { event: 'delta', data: { text: e.delta } };
          // Save progress now and then, so someone who left and came back sees it filling in.
          if (Date.now() - savedAt > PROGRESS_SAVE_MS) {
            savedAt = Date.now();
            const sofar = run.prefix && text ? `${run.prefix}\n\n${text.trimStart()}` : run.prefix || text;
            await this.docs.updateOne({ _id: doc._id, status: 'writing' }, { $set: { markdown: sofar } });
          }
        } else {
          charged = e.credits;
          finished = e.outcome === 'ok';
        }
      }
    } catch (err) {
      error =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : {
              code: 'service_unavailable',
              message: 'Writing stopped because the model didn’t answer. No credits were used.',
            };
      if (!(err instanceof AppError)) this.logger.error({ err, requestId }, 'Document writing failed');
    }

    const joined = run.prefix && text ? `${run.prefix}\n\n${text.trimStart()}` : run.prefix || text;
    const done = sectionsDone(joined, total, finished);
    const status: DocumentRecord['status'] = error
      ? done > 0
        ? 'stopped'
        : 'failed'
      : finished
        ? 'ready'
        : 'stopped';
    // Stopped part-way: keep only the sections that were finished (they're the ones charged).
    const markdown = status === 'ready' ? joined.trim() : keepCompleteSections(joined, done);
    const plain = plainText(markdown);
    const saved = await this.docs
      .findOneAndUpdate(
        { _id: doc._id },
        {
          $set: {
            markdown,
            text: plain,
            wordCount: wordCount(plain),
            status,
            error,
            ...(model && { model: model.key, auto: model.auto }),
          },
          $inc: { credits: charged },
        },
        { new: true },
      )
      .lean<DocLean>();
    if (status === 'ready') await this.versions?.firstDraft(saved!, actor.userId);
    yield { event: status === 'failed' ? 'error' : 'done', data: { doc: await this.toDto(saved!) } };
  }

  /** Stop writing. The open stream saves the finished sections; if it isn't here, stop it in the record. */
  async stop(actor: Actor, id: string): Promise<{ stopped: boolean }> {
    const doc = await this.find(actor, id);
    if (liveRuns.stop(runKey.doc(doc._id.toHexString()))) return { stopped: true };
    if (doc.status !== 'writing') return { stopped: false };
    const done = sectionsDone(doc.markdown ?? '', doc.outline.length, false);
    const markdown = keepCompleteSections(doc.markdown ?? '', done);
    const plain = plainText(markdown);
    await this.docs.updateOne(
      { _id: doc._id, status: 'writing' },
      {
        $set: {
          markdown,
          text: plain,
          wordCount: wordCount(plain),
          status: 'stopped',
          error: null,
        },
      },
    );
    return { stopped: true };
  }

  /** Ask AI: rewrite the selected text (a quick action or the user's instruction). One message's credits. */
  async aiEdit(
    actor: Actor,
    id: string,
    input: {
      text: string;
      action?: EditAction;
      instruction?: string;
      language?: string;
      context?: string;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<EditResultDto> {
    const doc = await this.editable(actor, id);
    const m = editMessages({ ...input, title: doc.title });
    const project = await this.project(actor.workspaceId, doc.projectId);
    const key = new Types.ObjectId().toHexString();
    const result = await this.gateway.object({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      plan: actor.plan,
      tool: 'docs',
      model: input.model ?? AUTO,
      system: m.system + project.text,
      extraCredits: project.extraCredits,
      messages: [{ role: 'user', content: m.prompt }],
      key: `doc-edit:${key}`,
      ref: { kind: 'document', id: doc._id.toHexString() },
      abortSignal: signal,
      schema: editSchema,
      maxOutputTokens: 3000,
    });
    await this.charged(doc._id, result.credits);
    return {
      text: cleanRewrite(result.object.text),
      credits: result.credits,
      model: result.model.key,
      modelName: result.model.name,
      auto: result.auto,
    };
  }

  /**
   * The assistant panel: answers about the document and drafts new sections to add. It reads the
   * editor's current Markdown (sent by the client, so unsaved edits count). One message's credits.
   */
  async assistant(
    actor: Actor,
    id: string,
    input: {
      message: string;
      markdown: string;
      history: { role: 'user' | 'assistant'; content: string }[];
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<AssistantReplyDto> {
    const doc = await this.editable(actor, id);
    const m = assistantMessages({ title: doc.title, ...input });
    const project = await this.project(actor.workspaceId, doc.projectId);
    const key = new Types.ObjectId().toHexString();
    const result = await this.gateway.object({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      plan: actor.plan,
      tool: 'docs',
      model: input.model ?? AUTO,
      system: m.system + project.text,
      extraCredits: project.extraCredits,
      messages: m.messages,
      key: `doc-assist:${key}`,
      ref: { kind: 'document', id: doc._id.toHexString() },
      abortSignal: signal,
      schema: assistantSchema,
      maxOutputTokens: 4000,
    });
    await this.charged(doc._id, result.credits);
    const ins = result.object.insert;
    const markdown = ins?.markdown.trim() ?? '';
    return {
      reply: result.object.reply.trim(),
      insert:
        ins && markdown
          ? {
              heading: ins.heading.trim(),
              // Always starts with its heading, so it lands as a section of its own.
              markdown: /^##\s/.test(markdown) ? markdown : `## ${ins.heading.trim()}\n\n${markdown}`,
              after: ins.replaces ? null : ins.after?.trim() || null,
              replaces: ins.replaces?.trim() || null,
            }
          : null,
      truncated: m.truncated,
      credits: result.credits,
      model: result.model.key,
      modelName: result.model.name,
      auto: result.auto,
    };
  }

  private async editable(actor: Actor, id: string): Promise<DocLean> {
    const doc = await this.find(actor, id);
    if (doc.status === 'writing' && !isStale(doc))
      throw new AppError(
        'conflict',
        'Wait until the document has been written, then use AI on it.',
        HttpStatus.CONFLICT,
      );
    return doc;
  }

  private async charged(id: Types.ObjectId, credits: number) {
    // AI help used on a document counts toward its "credits used".
    if (credits > 0) await this.docs.updateOne({ _id: id }, { $inc: { credits } });
  }

  private async find(actor: Actor, id: string): Promise<DocLean> {
    const doc = await this.docs
      .findOne(scoped<DocumentRecord>(actor.workspaceId, { _id: oid(id) }))
      .lean<DocLean>();
    if (!doc) throw notFound();
    return doc;
  }

  private async toDto(d: DocLean, access: 'edit' | 'view' = 'edit'): Promise<DocDto> {
    const stale = d.status === 'writing' && isStale(d);
    // Saved Markdown only ever holds complete sections.
    const done = Math.min(d.outline.length, sectionsStarted(d.markdown ?? ''));
    const status = stale ? (done ? 'stopped' : 'failed') : d.status;
    return {
      ...toSummary(d),
      status,
      brief: d.brief ?? '',
      sections: (d.outline ?? []).map((s) => ({ heading: s.heading, note: s.note ?? '' })),
      length: d.length,
      tone: d.tone,
      markdown: d.markdown ?? '',
      content: d.content ?? null,
      requestedModel: d.requestedModel ?? AUTO,
      model: d.model ?? null,
      modelName: await this.models.nameOf(d.model),
      auto: !!d.auto,
      credits: d.credits ?? 0,
      sectionsDone: d.status === 'ready' ? d.outline.length : done,
      error: stale ? { code: 'service_unavailable', message: 'Writing was interrupted.' } : (d.error ?? null),
      createdAt: new Date(d.createdAt).toISOString(),
      access,
      linkAccess: d.linkAccess ?? 'off',
      sharedWith: access === 'edit' ? (d.invites ?? []).length : 0,
      // People it's shared with don't see the owner's projects.
      project:
        access === 'edit' && d.projectId && this.projectContext
          ? await this.projectContext
              .name(d.workspaceId, d.projectId)
              .then((name) => (name ? { id: d.projectId!.toHexString(), name } : null))
          : null,
      ...(access === 'view' && { brief: '', credits: 0 }),
    };
  }
}

function isStale(d: { updatedAt: Date }) {
  return Date.now() - new Date(d.updatedAt).getTime() > STALE_MS;
}

function toSummary(d: DocLean): DocSummaryDto {
  return {
    id: d._id.toHexString(),
    title: d.title,
    type: d.type,
    status: d.status,
    wordCount: d.wordCount ?? 0,
    updatedAt: new Date(d.updatedAt).toISOString(),
  };
}
