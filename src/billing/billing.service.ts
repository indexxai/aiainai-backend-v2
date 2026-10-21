import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { CreditEntry, type EntryType } from '../credits/credit.schema.js';
import { CreditsService } from '../credits/credits.service.js';
import { UsageEvent } from '../database/schemas/usage-event.schema.js';
import type { Plan } from '../database/schemas/workspace.schema.js';
import { ModelsService } from '../models/models.service.js';
import { PLAN_LIMITS } from '../plans/plans.config.js';
import type { BillingSummaryDto, HistoryDto, HistoryItemDto } from './billing.dto.js';

export const TOOL_LABELS: Record<string, string> = {
  chat: 'AI Chat',
  docs: 'AI Docs',
  image: 'AI Image',
  research: 'Research',
  team: 'AI Crews',
  files: 'Ask your files',
};

/** Ledger entries that mean something to people (holds and settlements are shown via usage). */
const SHOWN_ENTRIES: EntryType[] = ['grant', 'topup', 'expire', 'refund', 'adjustment'];
const PAGE = 30;

interface WorkspaceLike {
  _id: Types.ObjectId;
  plan: Plan;
  periodStart: Date;
  periodEnd: Date;
  proUntil?: Date | null;
}

type UsageRow = UsageEvent & { _id: Types.ObjectId; createdAt: Date };
type EntryRow = CreditEntry & { _id: Types.ObjectId; createdAt: Date };

/** What the Billing and usage page shows. Payments: see PaymentsService. */
@Injectable()
export class BillingService {
  constructor(
    private readonly credits: CreditsService,
    private readonly models: ModelsService,
    @InjectModel(UsageEvent.name) private readonly usage: Model<UsageEvent>,
    @InjectModel(CreditEntry.name) private readonly entries: Model<CreditEntry>,
  ) {}

  async summary(ws: WorkspaceLike): Promise<BillingSummaryDto> {
    const limits = PLAN_LIMITS[ws.plan];
    const [bal, byTool] = await Promise.all([
      this.credits.balance(ws._id),
      this.usage.aggregate<{ _id: string; credits: number }>([
        { $match: { workspaceId: ws._id, createdAt: { $gte: ws.periodStart } } },
        { $group: { _id: '$tool', credits: { $sum: '$credits' } } },
        { $sort: { credits: -1 } },
      ]),
    ]);
    const tools = byTool
      .filter((t) => t.credits > 0)
      .map((t) => ({ tool: t._id, label: TOOL_LABELS[t._id] ?? t._id, credits: t.credits }));
    return {
      plan: {
        key: ws.plan,
        label: limits.label,
        monthlyCredits: limits.monthlyCredits,
        periodStart: ws.periodStart.toISOString(),
        periodEnd: ws.periodEnd.toISOString(),
        paidUntil: ws.plan === 'pro' && ws.proUntil ? ws.proUntil.toISOString() : null,
      },
      credits: { ...bal, monthly: limits.monthlyCredits },
      // Files arrive in a later milestone; nothing is stored yet.
      storage: { usedBytes: 0, limitBytes: limits.storageBytes },
      byTool: tools,
      usedThisPeriod: tools.reduce((s, t) => s + t.credits, 0),
    };
  }

  /** Newest first: AI usage (charged, stopped, failed) and credits added or expired. */
  async history(ws: WorkspaceLike, cursor?: string): Promise<HistoryDto> {
    const before = cursor && Number.isFinite(Number(cursor)) ? new Date(Number(cursor)) : null;
    const time = before ? { createdAt: { $lt: before } } : {};
    const [usage, entries] = await Promise.all([
      this.usage
        .find({ workspaceId: ws._id, ...time })
        .sort({ createdAt: -1 })
        .limit(PAGE + 1)
        .lean<UsageRow[]>(),
      this.entries
        .find({ workspaceId: ws._id, type: { $in: SHOWN_ENTRIES }, ...time })
        .sort({ createdAt: -1 })
        .limit(PAGE + 1)
        .lean<EntryRow[]>(),
    ]);
    const rows: Array<HistoryItemDto & { t: number }> = [];
    for (const u of usage) rows.push({ ...(await this.usageItem(u)), t: new Date(u.createdAt).getTime() });
    for (const e of entries) rows.push({ ...entryItem(e), t: new Date(e.createdAt).getTime() });
    rows.sort((a, b) => b.t - a.t || b.id.localeCompare(a.id));
    const page = rows.slice(0, PAGE);
    const more = rows.length > PAGE;
    return {
      items: page.map(({ t: _t, ...item }) => item),
      nextCursor: more && page.length ? String(page[page.length - 1]!.t) : null,
    };
  }

  private async usageItem(u: UsageRow): Promise<HistoryItemDto> {
    const name =
      u.provider === 'demo'
        ? `${await this.models.nameOf(u.modelKey)} (sample)`
        : await this.models.nameOf(u.modelKey);
    const status: HistoryItemDto['status'] =
      u.outcome === 'ok' ? 'charged' : u.outcome === 'stopped' ? 'stopped' : 'failed';
    return {
      id: u._id.toHexString(),
      at: new Date(u.createdAt).toISOString(),
      activity: `${TOOL_LABELS[u.tool] ?? u.tool} · ${name}`,
      status,
      credits: u.credits ? -u.credits : 0,
    };
  }
}

function entryItem(e: EntryRow): HistoryItemDto {
  return {
    id: e._id.toHexString(),
    at: new Date(e.createdAt).toISOString(),
    activity: e.reason,
    status: e.amount < 0 ? 'expired' : 'added',
    credits: e.amount,
  };
}
