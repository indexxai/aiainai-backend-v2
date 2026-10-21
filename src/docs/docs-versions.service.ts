import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { DocVersion, type VersionKind } from '../database/schemas/doc-version.schema.js';
import { DocumentRecord } from '../database/schemas/document.schema.js';
import { scoped } from '../database/scoped.js';
import { PLAN_LIMITS } from '../plans/plans.config.js';
import type { Actor, DocLean } from './docs.service.js';
import type { VersionDetailDto, VersionDto } from './docs.dto.js';

type VersionLean = DocVersion & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/** While editing, keep a copy at most this often. */
export const AUTO_VERSION_MS = 5 * 60 * 1000;

const notFound = () => new AppError('not_found', 'We can’t find that version.', HttpStatus.NOT_FOUND);

/**
 * Versions of a document: the first draft, copies kept while editing (every few minutes), one
 * after each accepted AI change, ones the person names, and one just before a restore.
 * History is kept for the plan's window (Pro 90 days, Free 7); named versions are kept.
 */
@Injectable()
export class DocsVersionsService {
  constructor(
    @InjectModel(DocVersion.name) private readonly versions: Model<DocVersion>,
    @InjectModel(DocumentRecord.name) private readonly docs: Model<DocumentRecord>,
  ) {}

  /** Keep a copy of the document as it is. */
  async snapshot(doc: DocLean, kind: VersionKind, name: string, by: string): Promise<VersionLean> {
    const [v] = (await this.versions.create([
      {
        workspaceId: doc.workspaceId,
        docId: doc._id,
        kind,
        name: name.slice(0, 120),
        by,
        title: doc.title,
        markdown: doc.markdown ?? '',
        content: doc.content ?? null,
        text: doc.text ?? '',
        wordCount: doc.wordCount ?? 0,
      },
    ])) as unknown as VersionLean[];
    return v!;
  }

  /**
   * Called before an edit replaces the document: keep what's being replaced if the last copy
   * is a few minutes old (or `force`, before an AI change) and it isn't the same text.
   */
  async beforeEdit(doc: DocLean, by: string, force = false): Promise<void> {
    if (!doc.content && !doc.markdown) return;
    const last = await this.latest(doc._id);
    if (last && sameText(last, doc)) return;
    if (last && !force && Date.now() - new Date(last.createdAt).getTime() < AUTO_VERSION_MS) return;
    await this.snapshot(doc, 'auto', 'Auto-saved', by);
  }

  /** The AI's draft, once it's finished. */
  async firstDraft(doc: DocLean, by: string): Promise<void> {
    if (await this.versions.exists({ docId: doc._id, kind: 'first' })) return;
    await this.snapshot(doc, 'first', 'First draft', by);
  }

  async list(actor: Actor, docId: string): Promise<VersionDto[]> {
    const doc = await this.own(actor, docId);
    await this.prune(actor, doc._id);
    const rows = await this.versions
      .find({ docId: doc._id }, { content: 0, markdown: 0, text: 0 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(200)
      .lean<VersionLean[]>();
    return rows.map((v) => toDto(v, actor.userId));
  }

  async get(actor: Actor, docId: string, versionId: string): Promise<VersionDetailDto> {
    const doc = await this.own(actor, docId);
    const v = await this.version(doc._id, versionId);
    return {
      ...toDto(v, actor.userId),
      title: v.title,
      markdown: v.markdown ?? '',
      content: v.content ?? null,
    };
  }

  /** "Name the current version". */
  async name(actor: Actor, docId: string, name?: string): Promise<VersionDto> {
    const doc = await this.own(actor, docId);
    assertWritten(doc);
    const n = (await this.versions.countDocuments({ docId: doc._id, kind: 'named' })) + 1;
    const v = await this.snapshot(doc, 'named', name?.trim() || `Version ${n}`, actor.userId);
    return toDto(v, actor.userId);
  }

  /** Go back to a version. The current text is kept first, so this can be undone. */
  async restore(actor: Actor, docId: string, versionId: string): Promise<void> {
    const doc = await this.own(actor, docId);
    assertWritten(doc);
    const v = await this.version(doc._id, versionId);
    await this.snapshot(doc, 'restore', `Before restoring “${v.name}”`, actor.userId);
    await this.docs.updateOne(
      { _id: doc._id },
      {
        $set: {
          markdown: v.markdown ?? '',
          content: v.content ?? null,
          text: v.text ?? '',
          wordCount: v.wordCount ?? 0,
        },
      },
    );
  }

  private async prune(actor: Actor, docId: Types.ObjectId) {
    const days = PLAN_LIMITS[actor.plan].historyDays;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    await this.versions.deleteMany({ docId, kind: { $ne: 'named' }, createdAt: { $lt: cutoff } });
  }

  private async latest(docId: Types.ObjectId): Promise<VersionLean | undefined> {
    const [v] = await this.versions
      .find({ docId }, { content: 1, markdown: 1, createdAt: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .lean<VersionLean[]>();
    return v;
  }

  private async version(docId: Types.ObjectId, id: string): Promise<VersionLean> {
    if (!Types.ObjectId.isValid(id)) throw notFound();
    const v = await this.versions.findOne({ _id: new Types.ObjectId(id), docId }).lean<VersionLean>();
    if (!v) throw notFound();
    return v;
  }

  /** Versions are for the owner's workspace only (people it's shared with read the current one). */
  private async own(actor: Actor, id: string): Promise<DocLean> {
    if (!Types.ObjectId.isValid(id))
      throw new AppError('not_found', 'We can’t find that document.', HttpStatus.NOT_FOUND);
    const doc = await this.docs
      .findOne(scoped<DocumentRecord>(actor.workspaceId, { _id: new Types.ObjectId(id) }))
      .lean<DocLean>();
    if (!doc) throw new AppError('not_found', 'We can’t find that document.', HttpStatus.NOT_FOUND);
    return doc;
  }
}

function assertWritten(doc: DocLean) {
  if (doc.status === 'writing' || doc.status === 'draft')
    throw new AppError(
      'conflict',
      'Wait until the document has been written, then use Versions.',
      HttpStatus.CONFLICT,
    );
}

function sameText(
  a: { content?: unknown; markdown?: string },
  b: { content?: unknown; markdown?: string },
): boolean {
  return (
    JSON.stringify(a.content ?? null) === JSON.stringify(b.content ?? null) &&
    (a.markdown ?? '') === (b.markdown ?? '')
  );
}

function toDto(v: VersionLean, me: string): VersionDto {
  return {
    id: v._id.toHexString(),
    kind: v.kind,
    name: v.name,
    by: v.by === 'assistant' ? 'assistant' : v.by === me ? 'you' : 'teammate',
    named: v.kind === 'named',
    wordCount: v.wordCount ?? 0,
    createdAt: new Date(v.createdAt).toISOString(),
  };
}
