import type { Plan } from '../database/schemas/workspace.schema.js';
import { monthsAfter } from '../plans/plans.config.js';

/** Credit packs sold as one-time top-ups (US cents). Same rate as Jack Personal, a bonus on bigger packs. */
export const TOPUP_PACKS = {
  '500': { credits: 500, cents: 500 },
  '1200': { credits: 1200, cents: 1000 },
  '3000': { credits: 3000, cents: 2500 },
} as const;
export type PackId = keyof typeof TOPUP_PACKS;
export const PACK_IDS = Object.keys(TOPUP_PACKS) as PackId[];

/** One month of a paid plan, paid once (no automatic renewal). */
export const PLAN_PRICES = { pro: { cents: 2000, label: 'Jack Personal' } } as const;
export type PaidPlan = keyof typeof PLAN_PRICES;

export interface PlanState {
  plan: Plan;
  periodStart: Date;
  periodEnd: Date;
  planAnchor?: Date | null;
  proUntil?: Date | null;
}

export type PlanChange =
  | {
      mode: 'upgrade';
      set: { plan: 'pro'; planAnchor: Date; periodStart: Date; periodEnd: Date; proUntil: Date };
    }
  | { mode: 'extend'; set: { proUntil: Date } };

/**
 * What one paid month of Jack Personal does. On Free: Personal starts now, for a month (plan
 * credits are replaced by Personal's). Already on Personal: one more month after the paid one,
 * on the same day of the month.
 */
export function planAfterPayment(ws: PlanState, now: Date): PlanChange {
  if (ws.plan !== 'pro') {
    const end = monthsAfter(now, 1);
    return {
      mode: 'upgrade',
      set: { plan: 'pro', planAnchor: now, periodStart: now, periodEnd: end, proUntil: end },
    };
  }
  const anchor = ws.planAnchor ?? ws.periodStart;
  const paid = ws.proUntil && ws.proUntil > ws.periodEnd ? ws.proUntil : ws.periodEnd;
  return { mode: 'extend', set: { proUntil: monthsAfter(anchor, monthsFrom(anchor, paid) + 1) } };
}

/** Whole months from `anchor` to `date` (the first month boundary at or after it). */
export function monthsFrom(anchor: Date, date: Date): number {
  let n = Math.max(
    0,
    (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + date.getUTCMonth() - anchor.getUTCMonth() - 1,
  );
  while (monthsAfter(anchor, n) < date) n++;
  return n;
}

/**
 * The plan for the period starting at `start`. A paid Personal month ends at `proUntil`; a
 * Personal plan without one was given by hand (or before payments) and stays.
 */
export function planForPeriod(ws: Pick<PlanState, 'plan' | 'proUntil'>, start: Date): Plan {
  if (ws.plan !== 'pro') return ws.plan;
  return !ws.proUntil || ws.proUntil > start ? 'pro' : 'free';
}
