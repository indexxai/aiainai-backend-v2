import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { BrowserTask } from '../database/schemas/browser-task.schema.js';
import {
  JackAction,
  type EmailPayload,
  type EventPayload,
  type JackActionKind,
  type PurchasePayload,
  type SlackPayload,
} from '../database/schemas/jack-action.schema.js';
import { Workspace, type SpaceKind } from '../database/schemas/workspace.schema.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import type { SpaceScope } from '../workspaces/workspaces.service.js';
import type { JackActionDto } from './actions.dto.js';

type Lean = JackAction & { _id: Types.ObjectId; createdAt: Date };

const money = (n: number, c: string) => `${c} ${n.toLocaleString('en-US')}`;
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
};

/**
 * Jack's actions that wait for the person's OK (v2): paying, sending email, adding calendar
 * events. Nothing happens until approved; purchases also have to fit the Wallet's limits.
 */
@Injectable()
export class ActionsService {
  private readonly logger = new Logger(ActionsService.name);

  constructor(
    @InjectModel(JackAction.name) private readonly actions: Model<JackAction>,
    @InjectModel(BrowserTask.name) private readonly tasks: Model<BrowserTask>,
    @InjectModel(Workspace.name) private readonly workspaces: Model<Workspace>,
    private readonly wallet: WalletService,
    private readonly connections: ConnectionsService,
  ) {}

  async request(input: {
    workspaceId: Types.ObjectId;
    userId: string;
    kind: JackActionKind;
    title: string;
    payload: PurchasePayload | EmailPayload | EventPayload | SlackPayload;
    chatId?: Types.ObjectId | null;
    browserTaskId?: Types.ObjectId | null;
  }): Promise<Lean> {
    const row = await this.actions.create({
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      payload: input.payload,
      chatId: input.chatId ?? null,
      browserTaskId: input.browserTaskId ?? null,
    });
    return row.toObject() as unknown as Lean;
  }

  async get(workspaceId: Types.ObjectId, id: string): Promise<Lean | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.actions.findOne({ _id: new Types.ObjectId(id), workspaceId }).lean<Lean>();
  }

  /** Waiting and recently decided actions in these spaces. */
  async list(spaces: SpaceScope[]): Promise<{ pending: JackActionDto[]; decided: JackActionDto[] }> {
    const ids = spaces.map((s) => s.workspace._id);
    const spaceOf = new Map(spaces.map((s) => [s.workspace._id.toHexString(), s.space]));
    const rows = await this.actions
      .find({ workspaceId: { $in: ids } })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean<Lean[]>();
    const dtos = await Promise.all(
      rows.map((r) => this.toDto(r, spaceOf.get(String(r.workspaceId)) ?? 'personal')),
    );
    return {
      pending: dtos.filter((d) => d.status === 'pending'),
      decided: dtos.filter((d) => d.status !== 'pending').slice(0, 30),
    };
  }

  /** Find an action in any of the person's spaces. */
  private async find(
    spaces: SpaceScope[],
    id: string,
  ): Promise<{ row: Lean; space: SpaceKind; userId: string }> {
    for (const s of spaces) {
      const row = await this.get(s.workspace._id, id);
      if (row) return { row, space: s.space, userId: s.workspace.ownerUserId };
    }
    throw new AppError('not_found', 'We can’t find that request.', HttpStatus.NOT_FOUND);
  }

  async approve(spaces: SpaceScope[], id: string, input: { body?: string } = {}): Promise<JackActionDto> {
    const { row, space } = await this.find(spaces, id);
    if (row.status !== 'pending')
      throw new AppError('conflict', 'This was already decided.', HttpStatus.CONFLICT);
    // Claim it first, so a double click can't pay twice.
    const claimed = await this.actions.findOneAndUpdate(
      { _id: row._id, status: 'pending' },
      { $set: { decidedAt: new Date(), status: 'done', result: 'Working on it…' } },
      { new: true },
    );
    if (!claimed) throw new AppError('conflict', 'This was already decided.', HttpStatus.CONFLICT);

    let status: 'done' | 'failed' = 'done';
    let result = '';
    try {
      if (row.kind === 'purchase') {
        const p = row.payload as PurchasePayload;
        const receipt = await this.wallet.pay(row.workspaceId, row._id, p);
        result = `Paid ${money(p.amount, p.currency)} to ${p.seller} with a one-time card ending ${receipt.cardLast4} (test mode — no real money moved).`;
        await this.finishTask(row, 'done', `Paid ${money(p.amount, p.currency)} — receipt in Wallet`);
      } else if (row.kind === 'send_email') {
        const e = {
          ...(row.payload as EmailPayload),
          ...(input.body?.trim() && { body: input.body.trim() }),
        };
        await this.connections.sendEmail(row.workspaceId, e);
        result = `Sent to ${e.to}.`;
        if (input.body?.trim()) await this.actions.updateOne({ _id: row._id }, { $set: { payload: e } });
      } else if (row.kind === 'slack_message') {
        const m = {
          ...(row.payload as SlackPayload),
          ...(input.body?.trim() && { text: input.body.trim().slice(0, 4000) }),
        };
        await this.connections.slackSend(row.workspaceId, m);
        result = `Posted in #${m.channel}.`;
        if (input.body?.trim()) await this.actions.updateOne({ _id: row._id }, { $set: { payload: m } });
      } else {
        const ev = row.payload as EventPayload;
        await this.connections.createEvent(row.workspaceId, ev);
        result = `Added to Google Calendar: ${ev.title}, ${when(ev.start)}.`;
      }
    } catch (err) {
      status = 'failed';
      result = err instanceof AppError ? err.message : 'It didn’t go through. Nothing was sent or paid.';
      if (!(err instanceof AppError)) this.logger.error({ err, id }, 'Approved action failed');
      if (row.kind === 'purchase' && err instanceof AppError && err.code === 'conflict') {
        // Over a limit or a blocked site: put it back so it can be approved after a change.
        await this.actions.updateOne(
          { _id: row._id },
          { $set: { status: 'pending', result: '', decidedAt: null } },
        );
        throw err;
      }
    }
    const saved = await this.actions
      .findOneAndUpdate({ _id: row._id }, { $set: { status, result } }, { new: true })
      .lean<Lean>();
    return this.toDto(saved!, space);
  }

  async reject(spaces: SpaceScope[], id: string, note = ''): Promise<JackActionDto> {
    const { row, space } = await this.find(spaces, id);
    const saved = await this.actions
      .findOneAndUpdate(
        { _id: row._id, status: 'pending' },
        {
          $set: { status: 'rejected', note: note.slice(0, 300), decidedAt: new Date(), result: 'Not done.' },
        },
        { new: true },
      )
      .lean<Lean>();
    if (!saved) throw new AppError('conflict', 'This was already decided.', HttpStatus.CONFLICT);
    await this.finishTask(row, 'stopped', 'You said not now — nothing was paid');
    return this.toDto(saved, space);
  }

  /** A purchase's browser task ends when the purchase is decided. */
  private async finishTask(row: Lean, status: 'done' | 'stopped', text: string) {
    if (!row.browserTaskId) return;
    await this.tasks.updateOne(
      { _id: row.browserTaskId, status: { $in: ['waiting', 'paused', 'taken_over', 'running'] } },
      {
        $set: { status, summary: text },
        $push: { steps: { at: new Date(), text, state: status === 'done' ? 'done' : 'failed' } },
      },
    );
  }

  /** Called when a browser task is stopped: its waiting purchase is cancelled. */
  async cancelForTask(taskId: Types.ObjectId): Promise<void> {
    await this.actions.updateMany(
      { browserTaskId: taskId, status: 'pending' },
      {
        $set: {
          status: 'cancelled',
          decidedAt: new Date(),
          result: 'Cancelled — the browser task was stopped.',
        },
      },
    );
  }

  async toDto(r: Lean, known?: SpaceKind): Promise<JackActionDto> {
    const space =
      known ??
      ((await this.workspaces.findById(r.workspaceId, { kind: 1 }).lean<Pick<Workspace, 'kind'>>())?.kind ===
      'business'
        ? 'business'
        : 'personal');
    const base = {
      id: r._id.toHexString(),
      kind: r.kind,
      title: r.title,
      status: r.status,
      space,
      chatId: r.chatId ? String(r.chatId) : null,
      browserTaskId: r.browserTaskId ? String(r.browserTaskId) : null,
      result: r.result ?? '',
      note: r.note ?? '',
      createdAt: new Date(r.createdAt).toISOString(),
      decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
      blocked: null as string | null,
    };
    if (r.kind === 'purchase') {
      const p = r.payload as PurchasePayload;
      const [w, blocked] = await Promise.all([
        this.wallet.get(r.workspaceId),
        r.status === 'pending' ? this.wallet.check(r.workspaceId, p) : Promise.resolve(null),
      ]);
      return {
        ...base,
        blocked,
        amount: p.amount,
        currency: p.currency,
        details: [
          { label: 'Pay', value: `${money(p.amount, p.currency)} to ${p.seller}` },
          { label: 'For', value: p.item },
          { label: 'Site', value: p.site },
          {
            label: 'Card',
            value: `A one-time card made from your ${w.card.brand} •••• ${w.card.last4}, for this purchase only`,
          },
          { label: 'Refund rules', value: 'The seller’s own terms apply' },
        ],
        limits: [
          { label: 'Per purchase', used: p.amount, limit: w.perPurchase },
          { label: 'Today', used: w.spentToday + (r.status === 'pending' ? p.amount : 0), limit: w.perDay },
        ],
      };
    }
    if (r.kind === 'send_email') {
      const e = r.payload as EmailPayload;
      return {
        ...base,
        body: e.body,
        details: [
          { label: 'Send', value: `An email from your Gmail to ${e.to}` },
          { label: 'Subject', value: e.subject },
          { label: 'Text', value: e.body },
        ],
      };
    }
    if (r.kind === 'slack_message') {
      const m = r.payload as SlackPayload;
      return {
        ...base,
        body: m.text,
        details: [
          { label: 'Post', value: `A message from you in #${m.channel} on Slack` },
          { label: 'Text', value: m.text },
        ],
      };
    }
    const ev = r.payload as EventPayload;
    return {
      ...base,
      details: [
        { label: 'Add', value: `“${ev.title}” to your Google Calendar` },
        { label: 'When', value: `${when(ev.start)} · ${ev.minutes} minutes` },
      ],
    };
  }
}
