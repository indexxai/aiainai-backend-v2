import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import { CONNECTOR } from '../connections/connector.js';
import type { DemoConnector } from '../connections/demo-connector.js';
import { signedInApp } from '../testing/http-session.js';

const until = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 200): Promise<T> => {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 20));
    v = await fn();
  }
  return v;
};

describe('Jack’s browser, Wallet and approvals over HTTP (sample browser)', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  beforeAll(async () => {
    s = await signedInApp({ email: 'wallet@example.com' });
  });
  afterAll(async () => s?.close());

  const task = (id: string) => s.call.get(`/browser/${id}`).then((r) => r.body);

  it('books in the browser, stops at the payment, and pays (test mode) once approved', async () => {
    const { events, chatId } = await s.ask('Book two flights to Dubai on 14 Nov, morning, under PKR 110,000');
    const step = events.find((e) => e.event === 'plan')!.data.steps[0];
    expect(step).toMatchObject({ tool: 'browse', status: 'running' });
    const id = step.href.split('/').pop();

    const waiting = await until(
      () => task(id),
      (t) => t.status === 'waiting',
    );
    expect(waiting.steps.map((x: { text: string }) => x.text)).toEqual([
      'Opened skylineair.example',
      'Searched for flights',
      'Compared 6 options',
      'Chose SA 615 at 08:40 · PKR 98,400',
      'Filled in your details',
      'Payment — waiting for your OK',
    ]);
    expect(waiting.sample).toBe(true);
    expect(waiting.view.heading).toBe('Your details');
    expect(waiting.action).toMatchObject({
      kind: 'purchase',
      amount: 98_400,
      currency: 'PKR',
      blocked: null,
    });
    expect(waiting.action.details[0]).toEqual({ label: 'Pay', value: 'PKR 98,400 to Skyline Air' });

    // The conversation shows the purchase card; Approvals lists it.
    const chat = await s.call.get(`/chats/${chatId}`).expect(200);
    expect(chat.body.messages.at(-1).plan[0]).toMatchObject({
      status: 'waiting',
      action: { id: waiting.action.id },
    });
    const approvals = (await s.call.get('/approvals').expect(200)).body;
    expect(approvals.jackPending.map((a: { id: string }) => a.id)).toEqual([waiting.action.id]);

    const paid = await s.call.post(`/approvals/jack/${waiting.action.id}/approve`).expect(200);
    expect(paid.body.status).toBe('done');
    expect(paid.body.result).toMatch(
      /^Paid PKR 98,400 to Skyline Air with a one-time card ending \d{4} \(test mode/,
    );
    await s.call.post(`/approvals/jack/${waiting.action.id}/approve`).expect(409); // never twice
    expect((await task(id)).status).toBe('done');
    const wallet = (await s.call.get('/wallet').expect(200)).body;
    expect(wallet).toMatchObject({ spentToday: 98_400, test: true });
    const receipts = (await s.call.get('/wallet/receipts').expect(200)).body.items;
    expect(receipts[0]).toMatchObject({ seller: 'Skyline Air', amount: 98_400, status: 'paid', chatId });
    const activity = (await s.call.get('/activity?kind=purchases').expect(200)).body.items;
    expect(activity[0].text).toBe(
      'paid PKR 98,400 to Skyline Air for 2 seats, economy · SA 615 · 08:40 → 11:10',
    );
  });

  it('refuses a purchase over the limits until they are raised, and rejecting pays nothing', async () => {
    // Today already has 98,400; with 150,000 a day a second booking doesn't fit.
    await s.call.patch('/wallet', { perPurchase: 100_000, perDay: 150_000 }).expect(200);
    const a = await s.ask('Book two flights to Dubai for next week');
    const id = a.events
      .find((e) => e.event === 'plan')!
      .data.steps[0].href.split('/')
      .pop();
    const t = await until(
      () => task(id),
      (x) => x.status === 'waiting',
    );
    expect(t.action.blocked).toMatch(/per day/);
    const refused = await s.call.post(`/approvals/jack/${t.action.id}/approve`).expect(409);
    expect(refused.body.error.message).toMatch(/per day/);
    expect((await task(id)).action.status).toBe('pending');
    await s.call.patch('/wallet', { perDay: 300_000, perMonth: 600_000 }).expect(200);
    await s.call.patch('/wallet', { perPurchase: 400_000 }).expect(422); // must not exceed per day
    expect((await s.call.post(`/approvals/jack/${t.action.id}/approve`).expect(200)).body.status).toBe(
      'done',
    );

    const b = await s.ask('Order this week’s groceries');
    const id2 = b.events
      .find((e) => e.event === 'plan')!
      .data.steps[0].href.split('/')
      .pop();
    const t2 = await until(
      () => task(id2),
      (x) => x.status === 'waiting',
    );
    await s.call.post(`/approvals/jack/${t2.action.id}/reject`, { note: 'Too expensive' }).expect(200);
    const after = await task(id2);
    expect(after.status).toBe('stopped');
    expect(after.steps.at(-1).text).toBe('You said not now — nothing was paid');
    expect((await s.call.get('/wallet/receipts')).body.items).toHaveLength(2);
  });

  it('pauses, is taken over, given back, and stopped (the waiting payment is cancelled)', async () => {
    const a = await s.ask('Buy a phone case on caseshop.example');
    const id = a.events
      .find((e) => e.event === 'plan')!
      .data.steps[0].href.split('/')
      .pop();
    await s.call.post(`/browser/${id}/pause`).expect(200);
    await s.call.post(`/browser/${id}/pause`).expect(409);
    await s.call.post(`/browser/${id}/takeover`).expect(200);
    expect((await task(id)).status).toBe('taken_over');
    await s.call.post(`/browser/${id}/giveback`).expect(200);
    const waiting = await until(
      () => task(id),
      (x) => x.status === 'waiting',
    );
    await s.call.post(`/browser/${id}/stop`).expect(200);
    const stopped = await task(id);
    expect(stopped.status).toBe('stopped');
    expect(stopped.action.status).toBe('cancelled');
    await s.call.post(`/approvals/jack/${waiting.action.id}/approve`).expect(409);
  });

  it('won’t open a blocked site', async () => {
    await s.call.patch('/wallet', { blockedSites: ['banking', 'gambling', 'casino-royal.com'] }).expect(200);
    const a = await s.ask('Buy chips on casino-royal.com');
    const id = a.events
      .find((e) => e.event === 'plan')!
      .data.steps[0].href.split('/')
      .pop();
    const t = await until(
      () => task(id),
      (x) => x.status === 'failed',
    );
    expect(t.summary).toBe('casino-royal.com is blocked in your Wallet (Gambling).');
  });

  it('emails and calendar events follow the connection level', async () => {
    const outbox = (s.app.get(CONNECTOR) as DemoConnector).outbox;
    await s.call.post('/connections/gmail/connect').expect(200);
    await s.call.post('/connections/google-calendar/connect').expect(200);

    // Ask first: the email waits; approving with an edit sends the edited text.
    const e = await s.ask('Send an email to ali@example.com about the Friday meeting');
    const step = e.events.find((x) => x.event === 'plan')!.data.steps[0];
    expect(step).toMatchObject({ tool: 'send_email', status: 'waiting', action: { kind: 'send_email' } });
    await s.call
      .post(`/approvals/jack/${step.action.id}/approve`, { body: 'See you Friday at 3.' })
      .expect(200);
    expect(outbox.at(-1)).toEqual({
      kind: 'email',
      data: { to: 'ali@example.com', subject: 'The Friday meeting', body: 'See you Friday at 3.' },
    });

    // Draft: saved as a Gmail draft, nothing to approve.
    await s.call.patch('/connections/gmail', { level: 'draft' }).expect(200);
    const d = await s.ask('Email sara@example.com about the invoice');
    expect(d.events.find((x) => x.event === 'plan')!.data.steps[0]).toMatchObject({
      status: 'done',
      detail: 'Draft saved in Gmail, to sara@example.com',
    });
    expect(outbox.at(-1)!.kind).toBe('draft');

    // Calendar on its own: added straight away. Read only: not done.
    await s.call.patch('/connections/google-calendar', { level: 'auto' }).expect(200);
    const c = await s.ask('Add dentist visit to my calendar');
    expect(c.events.find((x) => x.event === 'plan')!.data.steps[0]).toMatchObject({
      tool: 'add_event',
      status: 'done',
      detail: 'Added to Google Calendar',
    });
    expect(outbox.at(-1)).toMatchObject({ kind: 'event', data: { title: 'Dentist visit', minutes: 60 } });
    await s.call.patch('/connections/google-calendar', { level: 'read' }).expect(200);
    const r = await s.ask('Add lunch with Ali to my calendar');
    expect(r.events.find((x) => x.event === 'plan')!.data.steps[0]).toMatchObject({ status: 'skipped' });
    const rows = (await s.app.get(getModelToken('JackAction')).find({}).lean()) as unknown[];
    expect(rows.length).toBeGreaterThan(0);
  });
});
