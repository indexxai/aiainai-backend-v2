import { HttpStatus } from '@nestjs/common';
import { Types } from 'mongoose';
import { AppError } from '../common/api-error.js';

/**
 * In-memory credits for tests and the local demo backend: same hold → settle / release
 * contract as CreditsService, one balance per workspace.
 */
export class FakeCredits {
  readonly balances = new Map<string, number>();
  readonly calls: Array<{ op: string; amount?: number; actual?: number }> = [];
  /** Ledger-style rows for grants and expiries (what the billing history shows). */
  readonly entries: Array<{
    workspaceId: string;
    type: string;
    amount: number;
    reason: string;
    key: string;
    at: Date;
  }> = [];
  private readonly keys = new Set<string>();
  private readonly holds = new Map<string, { ws: string; amount: number }>();
  private n = 0;

  constructor(
    private readonly start = 100,
    /** Optional: also write grants/expiries here, shaped like `credit_entries`. */
    private readonly ledger?: { create(doc: object): Promise<unknown> },
  ) {}

  private record(e: { workspaceId: string; type: string; amount: number; reason: string; key: string }) {
    this.entries.push({ ...e, at: new Date() });
    void this.ledger?.create({
      workspaceId: new Types.ObjectId(e.workspaceId),
      type: e.type,
      bucket: e.type === 'topup' ? 'topup' : 'plan',
      amount: e.amount,
      idempotencyKey: e.key || `k${this.entries.length}`,
      reason: e.reason,
    });
  }

  private bal(ws: unknown) {
    const k = String(ws);
    if (!this.balances.has(k)) this.balances.set(k, this.start);
    return k;
  }

  async balance(ws: unknown) {
    const plan = this.balances.get(this.bal(ws))!;
    return { plan, topup: 0, held: 0, spendable: plan };
  }

  async grant(i: { workspaceId: unknown; amount: number; key?: string; reason?: string; bucket?: string }) {
    const k = this.bal(i.workspaceId);
    if (i.key) {
      if (this.keys.has(`${k}:${i.key}`)) return;
      this.keys.add(`${k}:${i.key}`);
    }
    this.balances.set(k, this.balances.get(k)! + i.amount);
    this.record({
      workspaceId: k,
      type: i.bucket === 'topup' ? 'topup' : 'grant',
      amount: i.amount,
      reason: i.reason ?? 'Credits added',
      key: i.key ?? '',
    });
  }

  async expirePlanCredits(i: { workspaceId: unknown; key: string; reason?: string }) {
    const k = this.bal(i.workspaceId);
    if (this.keys.has(`${k}:${i.key}`)) return 0;
    this.keys.add(`${k}:${i.key}`);
    const left = this.balances.get(k)!;
    this.balances.set(k, 0);
    if (left)
      this.record({
        workspaceId: k,
        type: 'expire',
        amount: -left,
        reason: i.reason ?? 'Unused plan credits expired at period end',
        key: i.key,
      });
    return left;
  }

  async hold(i: { workspaceId: unknown; amount: number }) {
    const k = this.bal(i.workspaceId);
    const have = this.balances.get(k)!;
    if (i.amount > have)
      throw new AppError(
        'insufficient_credits',
        'You don’t have enough credits for this.',
        HttpStatus.PAYMENT_REQUIRED,
        {
          needed: i.amount,
          available: have,
        },
      );
    this.balances.set(k, have - i.amount);
    const holdId = `h${++this.n}`;
    this.holds.set(holdId, { ws: k, amount: i.amount });
    this.calls.push({ op: 'hold', amount: i.amount });
    return { holdId, allocation: [] };
  }

  async settle(i: { holdId: string; actual: number }) {
    const h = this.holds.get(i.holdId);
    if (!h) throw new AppError('not_found', 'That credit hold does not exist.', HttpStatus.NOT_FOUND);
    this.holds.delete(i.holdId);
    const back = Math.max(0, h.amount - i.actual);
    this.balances.set(h.ws, this.balances.get(h.ws)! + back);
    this.calls.push(i.actual ? { op: 'settle', actual: i.actual } : { op: 'release' });
    return { charged: Math.min(i.actual, h.amount), released: back, shortfall: 0 };
  }

  release(i: { holdId: string }) {
    return this.settle({ holdId: i.holdId, actual: 0 });
  }
}
