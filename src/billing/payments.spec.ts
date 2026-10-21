import Stripe from 'stripe';
import { Types, type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { CreditsService } from '../credits/credits.service.js';
import { PaymentSchema, type Payment } from '../database/schemas/payment.schema.js';
import { WorkspaceSchema, type Workspace } from '../database/schemas/workspace.schema.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { MemoryModel } from '../testing/memory-model.js';
import { SampleCheckout, StripeCheckout } from './checkout.js';
import { monthsFrom, planAfterPayment, planForPeriod } from './payments.logic.js';
import { PaymentsService } from './payments.service.js';

const d = (s: string) => new Date(s);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe('plan payments (logic)', () => {
  it('starts Personal now for a month when on Free', () => {
    const c = planAfterPayment(
      { plan: 'free', periodStart: d('2026-10-01T00:00:00Z'), periodEnd: d('2026-11-01T00:00:00Z') },
      d('2026-10-20T12:00:00Z'),
    );
    expect(c.mode).toBe('upgrade');
    expect(iso(c.set.proUntil)).toBe('2026-11-20');
  });

  it('adds a month after the paid one, on the same day', () => {
    const anchor = d('2026-01-31T10:00:00Z');
    const ws = {
      plan: 'pro' as const,
      planAnchor: anchor,
      periodStart: anchor,
      periodEnd: d('2026-02-28T10:00:00Z'),
      proUntil: d('2026-02-28T10:00:00Z'),
    };
    const once = planAfterPayment(ws, d('2026-02-10T00:00:00Z'));
    expect(iso(once.set.proUntil)).toBe('2026-03-31');
    const twice = planAfterPayment({ ...ws, proUntil: once.set.proUntil }, d('2026-02-11T00:00:00Z'));
    expect(iso(twice.set.proUntil)).toBe('2026-04-30');
    expect(monthsFrom(anchor, d('2026-04-30T10:00:00Z'))).toBe(3);
  });

  it('goes back to Free when the paid month ends', () => {
    const until = d('2026-11-20T12:00:00Z');
    expect(planForPeriod({ plan: 'pro', proUntil: until }, d('2026-10-20T12:00:00Z'))).toBe('pro');
    expect(planForPeriod({ plan: 'pro', proUntil: until }, until)).toBe('free');
    // Personal given by hand (no paid month) stays.
    expect(planForPeriod({ plan: 'pro', proUntil: null }, until)).toBe('pro');
  });
});

async function setup(plan: 'free' | 'pro' = 'free') {
  const workspaces = new MemoryModel('Workspace', WorkspaceSchema);
  const payments = new MemoryModel('Payment', PaymentSchema);
  const credits = new FakeCredits(0);
  const checkout = new SampleCheckout();
  const svc = new PaymentsService(
    checkout,
    credits as unknown as CreditsService,
    payments as unknown as Model<Payment>,
    workspaces as unknown as Model<Workspace>,
  );
  const now = new Date();
  const ws = (await workspaces.create({
    name: 'Mine',
    ownerUserId: 'u1',
    plan,
    kind: 'personal',
    periodStart: now,
    periodEnd: new Date(now.getTime() + 30 * 86_400_000),
  })) as { _id: Types.ObjectId };
  await credits.grant({ workspaceId: ws._id, amount: 100, key: 'start', bucket: 'plan' });
  const doc = async () => (await workspaces.findById(ws._id).lean()) as never;
  const pay = async (body: Parameters<PaymentsService['start']>[2]) => {
    const { url } = await svc.start(await doc(), { id: 'u1', email: 'a@b.co' }, body, 'http://app');
    return new URL(url).searchParams.get('checkout')!;
  };
  return { svc, credits, ws, pay, doc, payments, checkout };
}

describe('PaymentsService', () => {
  it('adds a top-up once, however many times it is confirmed', async () => {
    const { svc, credits, ws, pay, doc } = await setup();
    const id = await pay({ kind: 'topup', pack: '1200' });
    const r1 = await svc.confirm(await doc(), id);
    const r2 = await svc.confirm(await doc(), id);
    expect([r1.status, r2.status]).toEqual(['paid', 'paid']);
    expect((await credits.balance(ws._id)).spendable).toBe(1300);
    expect(credits.entries.at(-1)?.reason).toBe('Bought 1,200 credits');
    const listed = await svc.list(await doc());
    expect(listed.items.map((i) => [i.item, i.amountCents])).toEqual([['1,200 credits', 1000]]);
  });

  it('upgrades Free to Personal for a month, then a second payment extends it', async () => {
    const { svc, credits, ws, pay, doc } = await setup();
    const first = await svc.confirm(await doc(), await pay({ kind: 'plan', plan: 'pro' }));
    const after = (await doc()) as Workspace;
    expect(after.plan).toBe('pro');
    expect(first.paidUntil).toBe(after.proUntil!.toISOString());
    // Free's 100 expire; Personal's 2,000 arrive.
    expect((await credits.balance(ws._id)).spendable).toBe(2000);

    await svc.confirm(await doc(), await pay({ kind: 'plan', plan: 'pro' }));
    const extended = (await doc()) as Workspace;
    expect(monthsFrom(extended.planAnchor!, extended.proUntil!)).toBe(2);
    expect((await credits.balance(ws._id)).spendable).toBe(2000);
  });

  it('ignores a session whose amount does not match the price', async () => {
    const { svc, credits, ws } = await setup();
    await svc.fulfill({
      id: 'sample_x1234',
      paid: true,
      open: false,
      amountCents: 1,
      currency: 'usd',
      metadata: { workspaceId: ws._id.toHexString(), kind: 'topup', product: '3000' },
    });
    expect((await credits.balance(ws._id)).spendable).toBe(100);
  });

  it('refuses another workspace’s payment', async () => {
    const { svc, pay } = await setup();
    const id = await pay({ kind: 'topup', pack: '500' });
    const other = { _id: new Types.ObjectId() } as never;
    await expect(svc.confirm(other, id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Stripe webhook', () => {
  it('accepts a signed checkout.session.completed and rejects a bad signature', () => {
    const secret = 'whsec_test_secret';
    const co = new StripeCheckout('sk_test_123', secret);
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_abc',
          object: 'checkout.session',
          payment_status: 'paid',
          status: 'complete',
          amount_total: 1000,
          currency: 'usd',
          customer: 'cus_1',
          metadata: { workspaceId: 'w', kind: 'topup', product: '1200' },
        },
      },
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const ev = co.parseWebhook(Buffer.from(payload), header);
    expect(ev).toMatchObject({
      type: 'paid',
      session: { id: 'cs_test_abc', amountCents: 1000, customerId: 'cus_1' },
    });
    expect(() => co.parseWebhook(Buffer.from(payload), 't=1,v1=bad')).toThrow();
  });
});
