import { assistantOf } from '../assistant/assistant-name.js';
import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { Chat } from '../database/schemas/chat.schema.js';
import { DocumentRecord } from '../database/schemas/document.schema.js';
import { ImageGeneration } from '../database/schemas/image.schema.js';
import type { SpaceKind } from '../database/schemas/workspace.schema.js';
import { scoped } from '../database/scoped.js';
import {
  JackAction,
  type EmailPayload,
  type EventPayload,
  type PurchasePayload,
  type SlackPayload,
} from '../database/schemas/jack-action.schema.js';
import { ActionsService } from '../actions/actions.service.js';
import type { SpaceScope } from '../workspaces/workspaces.service.js';
import type { ActivityDto, ActivityItemDto, AllApprovalsDto } from './activity.dto.js';

const DAYS = 30;
const MAX_ITEMS = 80;
const PER_SOURCE = 40;

export type ActivityFilter = {
  space: 'all' | SpaceKind;
  kind: 'all' | 'conversation' | 'doc' | 'image' | 'purchases';
};

const SPACE_LABEL: Record<SpaceKind, string> = { personal: 'Personal', business: 'Business' };
const DOC_STATE: Record<string, string> = {
  ready: 'Ready',
  writing: 'Writing…',
  draft: 'Outline only',
  stopped: 'Stopped part-way',
  failed: 'Didn’t finish',
};
const IMAGE_STATE: Record<string, string> = {
  done: 'Ready',
  partial: 'Some ready',
  generating: 'Making…',
  failed: 'Didn’t come out',
  blocked: 'Refused by the model',
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const quote = (s: string) => `“${s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s}”`;
const iso = (d: unknown) => new Date(d as Date).toISOString();

type Lean<T> = T & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

/**
 * Activity (v2): one timeline of what the person and Jack did, and what's planned next. Also
 * Jack's Approvals list. Built from the records themselves,
 * so nothing extra is stored.
 */
@Injectable()
export class ActivityService {
  constructor(
    @InjectModel(Chat.name) private readonly chats: Model<Chat>,
    @InjectModel(DocumentRecord.name) private readonly docs: Model<DocumentRecord>,
    @InjectModel(ImageGeneration.name) private readonly images: Model<ImageGeneration>,
    @InjectModel(JackAction.name) private readonly jackActions: Model<JackAction>,
    @Optional() private readonly actions?: ActionsService,
  ) {}

  async activity(spaces: SpaceScope[], filter: ActivityFilter, now = new Date()): Promise<ActivityDto> {
    const since = new Date(now.getTime() - DAYS * 86_400_000);
    const picked = spaces.filter((s) => filter.space === 'all' || s.space === filter.space);
    const parts = await Promise.all(picked.map((s) => this.forSpace(s, filter, since)));
    const items = parts
      .flatMap((p) => p.items)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, MAX_ITEMS);
    const comingUp = parts.flatMap((p) => p.comingUp).slice(0, 10);
    return { items, comingUp };
  }

  private async forSpace(scope: SpaceScope, filter: ActivityFilter, since: Date) {
    const ws = scope.workspace._id;
    const space = scope.space;
    const want = (k: ActivityFilter['kind']) => filter.kind === 'all' || filter.kind === k;
    const recent = { createdAt: { $gte: since } };
    const [chats, docs, images, jackActions] = await Promise.all([
      want('conversation')
        ? this.chats
            .find(scoped<Chat>(ws, { lastMessageAt: { $gte: since }, messageCount: { $gt: 0 } }))
            .sort({ lastMessageAt: -1 })
            .limit(PER_SOURCE)
            .lean<Lean<Chat>[]>()
        : [],
      want('doc')
        ? this.docs
            .find(scoped<DocumentRecord>(ws, recent))
            .sort({ createdAt: -1 })
            .limit(PER_SOURCE)
            .lean<Lean<DocumentRecord>[]>()
        : [],
      want('image')
        ? this.images
            .find(scoped<ImageGeneration>(ws, recent))
            .sort({ createdAt: -1 })
            .limit(PER_SOURCE)
            .lean<Lean<ImageGeneration>[]>()
        : [],
      filter.kind === 'all' || filter.kind === 'purchases'
        ? this.jackActions
            .find({
              workspaceId: ws,
              ...recent,
              ...(filter.kind === 'purchases' && { kind: 'purchase' }),
              status: { $ne: 'cancelled' },
            })
            .sort({ createdAt: -1 })
            .limit(PER_SOURCE)
            .lean<Lean<JackAction>[]>()
        : [],
    ]);
    const where = SPACE_LABEL[space];
    const items: ActivityItemDto[] = [];
    const base = { space, waiting: false };
    const jack = assistantOf(scope.workspace);
    const jackName = jack.title;

    for (const c of chats)
      items.push({
        ...base,
        id: `chat:${c._id.toHexString()}`,
        at: iso(c.lastMessageAt),
        kind: 'conversation',
        who: 'you',
        whoName: 'You',
        icon: 'message-square',
        text: `talked with ${jack.name}: ${quote(c.title)}`,
        detail: `${where} · ${plural(c.messageCount, 'message')}`,
        href: `/chat/${c._id.toHexString()}`,
      });

    for (const d of docs) {
      const who = d.madeBy === 'jack' ? 'jack' : d.madeBy === 'team' ? 'team' : 'you';
      items.push({
        ...base,
        id: `doc:${d._id.toHexString()}`,
        at: iso(d.createdAt),
        kind: 'doc',
        who,
        whoName: who === 'jack' ? jackName : who === 'team' ? 'Your team' : 'You',
        icon: 'file-text',
        text: `made the document ${quote(d.title)}`,
        detail: `${where} · AI Docs · ${DOC_STATE[d.status] ?? d.status}`,
        href: `/docs/${d._id.toHexString()}`,
      });
    }

    for (const g of images) {
      const who = g.madeBy === 'jack' ? 'jack' : g.madeBy === 'team' ? 'team' : 'you';
      items.push({
        ...base,
        id: `image:${g._id.toHexString()}`,
        at: iso(g.createdAt),
        kind: 'image',
        who,
        whoName: who === 'jack' ? jackName : who === 'team' ? 'Your team' : 'You',
        icon: 'image',
        text: `made ${plural(g.count, 'image')}: ${quote(g.title || g.prompt)}`,
        detail: `${where} · AI Image · ${IMAGE_STATE[g.status] ?? g.status}`,
        href: `/image/${g._id.toHexString()}`,
      });
    }

    for (const a of jackActions) {
      const pay = a.kind === 'purchase' ? (a.payload as PurchasePayload) : null;
      const icon =
        a.kind === 'purchase'
          ? 'credit-card'
          : a.kind === 'send_email'
            ? 'mail'
            : a.kind === 'slack_message'
              ? 'hash'
              : 'calendar';
      const what =
        a.kind === 'purchase'
          ? `paid ${pay!.currency} ${pay!.amount.toLocaleString('en-US')} to ${pay!.seller} for ${pay!.item}`
          : a.kind === 'send_email'
            ? `sent the email ${quote((a.payload as EmailPayload).subject)} to ${(a.payload as EmailPayload).to}`
            : a.kind === 'slack_message'
              ? `posted in #${(a.payload as SlackPayload).channel} on Slack`
              : `added ${quote((a.payload as EventPayload).title)} to your calendar`;
      const decided = a.decidedAt ? iso(a.decidedAt) : iso(a.updatedAt);
      if (a.status === 'pending')
        items.push({
          ...base,
          id: `action:${a._id.toHexString()}`,
          at: iso(a.createdAt),
          kind: 'action',
          who: 'jack',
          whoName: jackName,
          icon,
          text: `asked for your OK: ${quote(a.title)}`,
          detail: `${where} · waiting for you`,
          href: '/approvals',
          waiting: true,
        });
      else if (a.status === 'rejected')
        items.push({
          ...base,
          id: `action:${a._id.toHexString()}`,
          at: decided,
          kind: 'action',
          who: 'you',
          whoName: 'You',
          icon: 'x',
          text: `said not now: ${quote(a.title)}`,
          detail: `${where}${a.note ? ` · “${a.note}”` : ''} · nothing was ${pay ? 'paid' : 'sent'}`,
          href: '/approvals',
        });
      else
        items.push({
          ...base,
          id: `action:${a._id.toHexString()}`,
          at: decided,
          kind: 'action',
          who: 'jack',
          whoName: jackName,
          icon,
          text: a.status === 'done' ? what : `couldn’t finish: ${quote(a.title)}`,
          detail: `${where} · ${a.status === 'done' ? (pay ? 'you approved · test payment' : 'you approved') : a.result}`,
          href: pay ? '/wallet' : '/approvals',
        });
    }

    // Nothing is scheduled ahead yet.
    const comingUp: ActivityDto['comingUp'] = [];
    return { items, comingUp };
  }

  /** What Jack wants to do (pay, send, add), waiting for the person or decided. */
  async allApprovals(spaces: SpaceScope[]): Promise<AllApprovalsDto> {
    const jack = this.actions ? await this.actions.list(spaces) : { pending: [], decided: [] };
    return { jackPending: jack.pending, jackDecided: jack.decided };
  }
}
