import type { Bucket } from './credit.schema.js';

export interface Balances {
  plan: number;
  topup: number;
  held: number;
}

export interface Allocation {
  bucket: Bucket;
  amount: number;
}

export const spendable = (b: Balances): number => b.plan + b.topup;

/**
 * Split an amount across buckets: plan credits first (they expire at period end), then
 * top-up credits (they roll over). Returns null when there are not enough credits.
 */
export function allocate(amount: number, b: Pick<Balances, 'plan' | 'topup'>): Allocation[] | null {
  assertCredits(amount);
  if (amount === 0) return [];
  if (b.plan + b.topup < amount) return null;
  const fromPlan = Math.min(b.plan, amount);
  const fromTopup = amount - fromPlan;
  const out: Allocation[] = [];
  if (fromPlan > 0) out.push({ bucket: 'plan', amount: fromPlan });
  if (fromTopup > 0) out.push({ bucket: 'topup', amount: fromTopup });
  return out;
}

/**
 * Settle a hold: the actual cost is taken from what was reserved (in the same buckets, plan
 * first); anything reserved but not used is returned. If the actual cost is higher than the
 * hold, the extra is reported so the caller can charge it from the remaining balance.
 */
export function settle(
  hold: Allocation[],
  actual: number,
): { charge: Allocation[]; release: Allocation[]; extra: number } {
  assertCredits(actual);
  const reserved = hold.reduce((s, a) => s + a.amount, 0);
  let left = Math.min(actual, reserved);
  const charge: Allocation[] = [];
  const release: Allocation[] = [];
  for (const a of hold) {
    const take = Math.min(a.amount, left);
    left -= take;
    if (take > 0) charge.push({ bucket: a.bucket, amount: take });
    if (a.amount - take > 0) release.push({ bucket: a.bucket, amount: a.amount - take });
  }
  return { charge, release, extra: Math.max(0, actual - reserved) };
}

/** Credits are whole numbers, never negative amounts in an operation. */
export function assertCredits(n: number): void {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`Credit amounts must be whole numbers ≥ 0 (got ${n})`);
}
