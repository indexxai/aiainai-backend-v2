import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { CreditAccount, CreditEntry, type Bucket, type EntryType } from './credit.schema.js';
import { allocate, assertCredits, settle, type Allocation, type Balances } from './ledger.logic.js';

type Id = Types.ObjectId | string;
const oid = (id: Id) => (typeof id === 'string' ? new Types.ObjectId(id) : id);

export interface Ref {
  kind: string;
  id: string;
}

export interface HoldResult {
  holdId: string;
  allocation: Allocation[];
}

export interface SettleResult {
  charged: number;
  released: number;
  /** Cost above the hold that could not be covered (absorbed by us, logged for review). */
  shortfall: number;
}

/**
 * Credits: grant, hold before an AI call, settle (charge actual + release the rest), expire.
 *
 * Guarantees:
 * - Every movement is a ledger entry written in the same transaction as the balance change.
 * - Spending uses a conditional update, so concurrent requests can't overspend.
 * - Every operation takes an idempotency key; repeating it never moves credits twice.
 */
@Injectable()
export class CreditsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(CreditAccount.name) private readonly accounts: Model<CreditAccount>,
    @InjectModel(CreditEntry.name) private readonly entries: Model<CreditEntry>,
  ) {}

  async balance(workspaceId: Id): Promise<Balances & { spendable: number }> {
    const acc = await this.accounts.findOne({ workspaceId: oid(workspaceId) }).lean();
    const b = { plan: acc?.plan ?? 0, topup: acc?.topup ?? 0, held: acc?.held ?? 0 };
    return { ...b, spendable: b.plan + b.topup };
  }

  /** Add credits: monthly plan grant (`plan`) or a purchase (`topup`). */
  async grant(input: {
    workspaceId: Id;
    bucket: Bucket;
    amount: number;
    key: string;
    reason: string;
    ref?: Ref;
    actor?: string;
  }): Promise<void> {
    assertCredits(input.amount);
    const ws = oid(input.workspaceId);
    await this.tx(async (session) => {
      if (await this.seen(ws, input.key, session)) return;
      await this.accounts.updateOne(
        { workspaceId: ws },
        { $inc: { [input.bucket]: input.amount } },
        { upsert: true, session },
      );
      await this.write(session, [
        {
          workspaceId: ws,
          type: input.bucket === 'plan' ? 'grant' : 'topup',
          bucket: input.bucket,
          amount: input.amount,
          idempotencyKey: input.key,
          reason: input.reason,
          ref: input.ref,
          actor: input.actor,
        },
      ]);
    });
  }

  /**
   * Reserve credits before starting paid work. Throws `insufficient_credits` (402) when
   * there aren't enough. Call `settle` when the work finishes, or `release` if it fails.
   */
  async hold(input: {
    workspaceId: Id;
    amount: number;
    key: string;
    reason: string;
    ref?: Ref;
  }): Promise<HoldResult> {
    assertCredits(input.amount);
    const ws = oid(input.workspaceId);
    return this.tx(async (session) => {
      const prior = await this.entries
        .find({ workspaceId: ws, idempotencyKey: input.key, type: 'hold' }, null, { session })
        .lean();
      if (prior.length) {
        return {
          holdId: prior[0]!.holdId!,
          allocation: prior.map((e) => ({ bucket: e.bucket, amount: -e.amount })),
        };
      }
      const holdId = new Types.ObjectId().toHexString();
      // Two attempts: the second covers a balance changed by a concurrent request between read and write.
      for (let attempt = 0; attempt < 2; attempt++) {
        const acc = await this.accounts.findOne({ workspaceId: ws }, null, { session }).lean();
        const allocation = allocate(input.amount, { plan: acc?.plan ?? 0, topup: acc?.topup ?? 0 });
        if (!allocation) break;
        const plan = allocation.find((a) => a.bucket === 'plan')?.amount ?? 0;
        const topup = allocation.find((a) => a.bucket === 'topup')?.amount ?? 0;
        const updated = await this.accounts.findOneAndUpdate(
          { workspaceId: ws, plan: { $gte: plan }, topup: { $gte: topup } },
          { $inc: { plan: -plan, topup: -topup, held: input.amount } },
          { session, new: true },
        );
        if (!updated) continue;
        await this.write(
          session,
          allocation.map((a) => ({
            workspaceId: ws,
            type: 'hold' as const,
            bucket: a.bucket,
            amount: -a.amount,
            heldDelta: a.amount,
            holdId,
            idempotencyKey: input.key,
            reason: input.reason,
            ref: input.ref,
          })),
        );
        return { holdId, allocation };
      }
      throw new AppError(
        'insufficient_credits',
        'You don’t have enough credits for this.',
        HttpStatus.PAYMENT_REQUIRED,
        {
          needed: input.amount,
        },
      );
    });
  }

  /**
   * Finish paid work: charge the actual cost from the hold and return the rest.
   * Cost above the hold is charged from the remaining balance if possible.
   */
  async settle(input: {
    workspaceId: Id;
    holdId: string;
    actual: number;
    reason: string;
    ref?: Ref;
  }): Promise<SettleResult> {
    assertCredits(input.actual);
    const ws = oid(input.workspaceId);
    const key = `settle:${input.holdId}`;
    return this.tx(async (session) => {
      const done = await this.entries
        .find({ workspaceId: ws, idempotencyKey: key }, null, { session })
        .lean();
      if (done.length) return summarize(done);

      const holdEntries = await this.entries
        .find({ workspaceId: ws, holdId: input.holdId, type: 'hold' }, null, { session })
        .lean();
      if (!holdEntries.length)
        throw new AppError('not_found', 'That credit hold does not exist.', HttpStatus.NOT_FOUND);
      const hold = holdEntries.map((e) => ({ bucket: e.bucket, amount: -e.amount }));
      const { charge, release, extra } = settle(hold, input.actual);
      const reserved = hold.reduce((s, a) => s + a.amount, 0);

      const inc: Record<string, number> = { held: -reserved };
      for (const r of release) inc[r.bucket] = (inc[r.bucket] ?? 0) + r.amount;

      const rows: Array<Pick<CreditEntry, 'type' | 'bucket' | 'amount' | 'heldDelta'>> = [
        ...charge.map((c) => ({
          type: 'charge' as const,
          bucket: c.bucket,
          amount: 0,
          heldDelta: -c.amount,
        })),
        ...release.map((r) => ({
          type: 'release' as const,
          bucket: r.bucket,
          amount: r.amount,
          heldDelta: -r.amount,
        })),
      ];

      let shortfall = 0;
      if (extra > 0) {
        const acc = await this.accounts.findOne({ workspaceId: ws }, null, { session }).lean();
        const free = {
          plan: (acc?.plan ?? 0) + (inc.plan ?? 0),
          topup: (acc?.topup ?? 0) + (inc.topup ?? 0),
        };
        const coverable = Math.min(extra, free.plan + free.topup);
        shortfall = extra - coverable;
        for (const a of allocate(coverable, free) ?? []) {
          inc[a.bucket] = (inc[a.bucket] ?? 0) - a.amount;
          rows.push({ type: 'charge', bucket: a.bucket, amount: -a.amount, heldDelta: 0 });
        }
      }

      await this.accounts.updateOne({ workspaceId: ws }, { $inc: inc }, { session });
      await this.write(
        session,
        rows.map((r) => ({
          ...r,
          workspaceId: ws,
          holdId: input.holdId,
          idempotencyKey: key,
          reason: shortfall ? `${input.reason} (shortfall ${shortfall})` : input.reason,
          ref: input.ref,
        })) as CreditEntry[],
      );
      return { ...summarize(rows), shortfall };
    });
  }

  /** The work failed or was cancelled before any cost: return the whole hold. */
  release(input: { workspaceId: Id; holdId: string; reason: string; ref?: Ref }): Promise<SettleResult> {
    return this.settle({ ...input, actual: 0 });
  }

  /** At the end of a plan period, unused plan credits expire (top-up credits never do). */
  async expirePlanCredits(input: { workspaceId: Id; key: string; reason?: string }): Promise<number> {
    const ws = oid(input.workspaceId);
    return this.tx(async (session) => {
      if (await this.seen(ws, input.key, session)) return 0;
      const acc = await this.accounts.findOne({ workspaceId: ws }, null, { session }).lean();
      const left = acc?.plan ?? 0;
      if (left === 0) return 0;
      const updated = await this.accounts.findOneAndUpdate(
        { workspaceId: ws, plan: left },
        { $inc: { plan: -left } },
        { session },
      );
      if (!updated)
        throw new AppError('conflict', 'Credits changed while expiring; try again.', HttpStatus.CONFLICT);
      await this.write(session, [
        {
          workspaceId: ws,
          type: 'expire',
          bucket: 'plan',
          amount: -left,
          idempotencyKey: input.key,
          reason: input.reason ?? 'Unused plan credits expired at period end',
        },
      ]);
      return left;
    });
  }

  private async seen(ws: Types.ObjectId, key: string, session: ClientSession): Promise<boolean> {
    return !!(await this.entries.exists({ workspaceId: ws, idempotencyKey: key }).session(session));
  }

  private async write(
    session: ClientSession,
    rows: Array<Partial<CreditEntry> & { type: EntryType }>,
  ): Promise<void> {
    if (rows.length) await this.entries.insertMany(rows, { session, ordered: true });
  }

  /**
   * Run in a transaction; Mongoose retries transient errors (e.g. write conflicts).
   * A duplicate idempotency key means a concurrent identical request won the race: run once
   * more, which then finds the existing entries and returns the same result.
   */
  private async tx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await this.connection.transaction(fn);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return this.connection.transaction(fn);
      throw err;
    }
  }
}

function summarize(rows: Array<Pick<CreditEntry, 'type' | 'amount' | 'heldDelta'>>): SettleResult {
  let charged = 0;
  let released = 0;
  for (const r of rows) {
    if (r.type === 'charge') charged += -(r.heldDelta ?? 0) + -(r.amount ?? 0);
    if (r.type === 'release') released += r.amount;
  }
  return { charged, released, shortfall: 0 };
}
