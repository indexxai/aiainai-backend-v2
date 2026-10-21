import type { Plan } from '../database/schemas/workspace.schema.js';

/**
 * Plan limits from the Billing designs. These are defaults for a new database; once the
 * Admin plan editor exists, the stored values win.
 */
export const PLAN_LIMITS: Record<
  Plan,
  { monthlyCredits: number; storageBytes: number; label: string; historyDays: number }
> = {
  free: { monthlyCredits: 100, storageBytes: 1 * 1024 ** 3, label: 'Jack Free', historyDays: 7 },
  pro: { monthlyCredits: 2000, storageBytes: 20 * 1024 ** 3, label: 'Jack Personal', historyDays: 90 },
};

/** One calendar month from `start` (same day next month, clamped to month end). */
export function periodEndFrom(start: Date): Date {
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

/** `anchor` plus `months` calendar months, keeping the anchor's day (clamped to month end). */
export function monthsAfter(anchor: Date, months: number): Date {
  const d = new Date(anchor);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * The plan period containing `now`, counted in whole months from `anchor` (when the plan
 * started), so a plan started on the 31st renews on the last day of short months and goes
 * back to the 31st after them. Missed months (an account unused for a while) are skipped.
 */
export function periodAt(anchor: Date, now: Date): { start: Date; end: Date } {
  let n = Math.max(
    0,
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth() - 1,
  );
  while (monthsAfter(anchor, n + 1) <= now) n++;
  return { start: monthsAfter(anchor, n), end: monthsAfter(anchor, n + 1) };
}
