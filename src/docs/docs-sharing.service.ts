import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import { DocumentRecord, type DocInvite } from '../database/schemas/document.schema.js';
import { scoped } from '../database/scoped.js';
import { EmailService } from '../email/email.service.js';
import { docSharedEmail } from '../email/templates.js';
import type { PublicDocDto, ShareDto } from './docs.dto.js';
import type { Actor } from './docs.service.js';

/** The most people one document can be shared with. */
export const MAX_INVITES = 50;

type DocLean = DocumentRecord & { _id: Types.ObjectId; updatedAt: Date };

const notFound = () => new AppError('not_found', 'We can’t find that document.', HttpStatus.NOT_FOUND);
const newToken = () => randomBytes(18).toString('base64url');

/**
 * Read-only sharing for AI Docs: a public link anyone can open (off by default, can be reset),
 * and invites by email — invited people see the document under "Shared with me" once they sign
 * in with that address. Nobody but the owner's workspace can edit.
 */
@Injectable()
export class DocsSharingService {
  private readonly logger = new Logger(DocsSharingService.name);

  constructor(
    @InjectModel(DocumentRecord.name) private readonly docs: Model<DocumentRecord>,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async get(actor: Actor, id: string): Promise<ShareDto> {
    return this.toDto(await this.own(actor, id));
  }

  async update(actor: Actor, id: string, input: { linkAccess?: 'off' | 'view'; resetLink?: boolean }) {
    const doc = await this.own(actor, id);
    const $set: Partial<DocumentRecord> = {};
    if (input.linkAccess) $set.linkAccess = input.linkAccess;
    const on = (input.linkAccess ?? doc.linkAccess) === 'view';
    // A token is made the first time the link is turned on, and again on reset.
    if (on && (!doc.shareToken || input.resetLink)) $set.shareToken = newToken();
    const updated = await this.docs
      .findOneAndUpdate({ _id: doc._id }, { $set }, { new: true })
      .lean<DocLean>();
    return this.toDto(updated!);
  }

  async invite(
    actor: Actor & { name: string },
    id: string,
    input: { emails: string[]; message?: string },
  ): Promise<ShareDto> {
    const doc = await this.own(actor, id);
    const me = actor.email?.toLowerCase();
    const have = new Set((doc.invites ?? []).map((i) => i.email));
    const fresh = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))].filter(
      (e) => e !== me && !have.has(e),
    );
    if (have.size + fresh.length > MAX_INVITES)
      throw new AppError(
        'conflict',
        `A document can be shared with up to ${MAX_INVITES} people.`,
        HttpStatus.CONFLICT,
      );
    if (!fresh.length) return this.toDto(doc);
    const now = new Date();
    const added: DocInvite[] = fresh.map((email) => ({ email, invitedAt: now, invitedBy: actor.name }));
    const updated = await this.docs
      .findOneAndUpdate({ _id: doc._id }, { $push: { invites: { $each: added } } }, { new: true })
      .lean<DocLean>();

    const url = `${this.appUrl()}/docs/${doc._id.toHexString()}`;
    await Promise.all(
      fresh.map((to) =>
        this.email
          .send({
            to,
            ...docSharedEmail({ from: actor.name, title: doc.title, url, message: input.message }),
          })
          // The invite stands even if one email fails; the person can be sent the link another way.
          .catch((err) => this.logger.error({ err, doc: doc._id }, 'Share email failed')),
      ),
    );
    return this.toDto(updated!);
  }

  async uninvite(actor: Actor, id: string, email: string): Promise<ShareDto> {
    const doc = await this.own(actor, id);
    const updated = await this.docs
      .findOneAndUpdate(
        { _id: doc._id },
        { $pull: { invites: { email: email.trim().toLowerCase() } } },
        { new: true },
      )
      .lean<DocLean>();
    return this.toDto(updated!);
  }

  /** The public, read-only view behind a share link. */
  async publicDoc(token: string): Promise<PublicDocDto> {
    if (!/^[\w-]{16,64}$/.test(token)) throw notFound();
    const d = await this.docs
      .findOne({ shareToken: token, linkAccess: 'view', deletedAt: null })
      .lean<DocLean>();
    // Only documents that have been written (or edited) are shown.
    if (!d || d.status === 'draft' || d.status === 'writing') throw notFound();
    return {
      title: d.title,
      type: d.type,
      markdown: d.markdown ?? '',
      content: d.content ?? null,
      wordCount: d.wordCount ?? 0,
      updatedAt: new Date(d.updatedAt).toISOString(),
    };
  }

  private async own(actor: Actor, id: string): Promise<DocLean> {
    if (!Types.ObjectId.isValid(id)) throw notFound();
    const doc = await this.docs
      .findOne(scoped<DocumentRecord>(actor.workspaceId, { _id: new Types.ObjectId(id) }))
      .lean<DocLean>();
    if (!doc) throw notFound();
    return doc;
  }

  private appUrl() {
    return this.config.get('APP_URL', { infer: true }).replace(/\/$/, '');
  }

  private toDto(d: DocLean): ShareDto {
    const on = d.linkAccess === 'view' && !!d.shareToken;
    return {
      linkAccess: on ? 'view' : 'off',
      url: on ? `${this.appUrl()}/s/${d.shareToken}` : null,
      invites: (d.invites ?? []).map((i) => ({
        email: i.email,
        invitedAt: new Date(i.invitedAt).toISOString(),
        role: 'view' as const,
      })),
    };
  }
}
