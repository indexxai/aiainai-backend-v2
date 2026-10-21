import { describe, expect, it } from 'vitest';
import { monthsAfter, periodAt } from './plans.config.js';

const d = (s: string) => new Date(s);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('plan periods', () => {
  it('keeps the start day, clamping in short months', () => {
    const jan31 = d('2026-01-31T10:00:00Z');
    expect(iso(monthsAfter(jan31, 1))).toBe('2026-02-28');
    expect(iso(monthsAfter(jan31, 2))).toBe('2026-03-31');
    expect(iso(monthsAfter(jan31, 13))).toBe('2027-02-28');
  });

  it('finds the period containing now, skipping missed months', () => {
    const anchor = d('2026-01-31T10:00:00Z');
    expect(periodAt(anchor, d('2026-02-01T00:00:00Z'))).toEqual({
      start: d('2026-01-31T10:00:00Z'),
      end: d('2026-02-28T10:00:00Z'),
    });
    const later = periodAt(anchor, d('2026-07-04T00:00:00Z'));
    expect([iso(later.start), iso(later.end)]).toEqual(['2026-06-30', '2026-07-31']);
    // exactly at a boundary, the new period has started
    expect(iso(periodAt(anchor, d('2026-02-28T10:00:00Z')).start)).toBe('2026-02-28');
  });

  it('is the first period before a month has passed', () => {
    const anchor = d('2026-10-05T09:00:00Z');
    expect(periodAt(anchor, d('2026-10-20T00:00:00Z'))).toEqual({
      start: anchor,
      end: d('2026-11-05T09:00:00Z'),
    });
  });
});
