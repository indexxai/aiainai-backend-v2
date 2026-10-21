import { allocate, assertCredits, settle, spendable } from './ledger.logic.js';

describe('ledger logic', () => {
  it('spends plan credits before top-up credits', () => {
    expect(allocate(5, { plan: 3, topup: 10 })).toEqual([
      { bucket: 'plan', amount: 3 },
      { bucket: 'topup', amount: 2 },
    ]);
    expect(allocate(2, { plan: 3, topup: 10 })).toEqual([{ bucket: 'plan', amount: 2 }]);
  });

  it('refuses to allocate more than is available', () => {
    expect(allocate(14, { plan: 3, topup: 10 })).toBeNull();
    expect(allocate(13, { plan: 3, topup: 10 })).not.toBeNull();
  });

  it('charges the actual cost and releases the rest of a hold', () => {
    const hold = [
      { bucket: 'plan' as const, amount: 3 },
      { bucket: 'topup' as const, amount: 2 },
    ];
    expect(settle(hold, 4)).toEqual({
      charge: [
        { bucket: 'plan', amount: 3 },
        { bucket: 'topup', amount: 1 },
      ],
      release: [{ bucket: 'topup', amount: 1 }],
      extra: 0,
    });
  });

  it('releases everything when the job fails (actual cost 0)', () => {
    const hold = [{ bucket: 'plan' as const, amount: 5 }];
    expect(settle(hold, 0)).toEqual({ charge: [], release: [{ bucket: 'plan', amount: 5 }], extra: 0 });
  });

  it('reports cost above the hold as extra', () => {
    expect(settle([{ bucket: 'plan', amount: 2 }], 5).extra).toBe(3);
  });

  it('only accepts whole, non-negative credit amounts', () => {
    expect(() => assertCredits(-1)).toThrow();
    expect(() => assertCredits(1.5)).toThrow();
    expect(() => assertCredits(0)).not.toThrow();
    expect(spendable({ plan: 2, topup: 3, held: 9 })).toBe(5);
  });
});
