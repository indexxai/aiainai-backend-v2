import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedInApp } from '../testing/http-session.js';

describe('Connections over HTTP (stand-in connector)', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  beforeAll(async () => {
    s = await signedInApp({ email: 'apps@example.com' });
    await s.addBusiness();
  });
  afterAll(async () => s?.close());

  const app = (body: { apps: { id: string }[] }, id: string) =>
    body.apps.find((a) => a.id === id) as unknown as {
      status: string;
      level: string;
      account: string | null;
    };

  it('lists apps per space, connects, sets the level and disconnects', async () => {
    const personal = (await s.call.get('/connections').expect(200)).body;
    expect(personal.demo).toBe(true);
    expect(personal.browser).toBe('sample');
    expect(personal.apps.map((a: { id: string }) => a.id)).toEqual([
      'gmail',
      'google-calendar',
      'google-drive',
      'slack',
      'outlook',
    ]);
    expect(app(personal, 'gmail')).toMatchObject({ status: 'not_connected', level: 'ask' });
    expect(app(personal, 'outlook')).toMatchObject({ status: 'coming' });
    const business = (await s.call.get('/connections', 'business').expect(200)).body;
    expect(business.apps.map((a: { id: string }) => a.id)).toContain('hubspot');

    const r = await s.call.post('/connections/google-calendar/connect').expect(200);
    expect(r.body.redirectUrl).toBeNull();
    expect(app(r.body.connections, 'google-calendar')).toMatchObject({
      status: 'connected',
      account: 'apps@example.com',
    });
    // Business has its own connections.
    expect(
      app((await s.call.get('/connections', 'business').expect(200)).body, 'google-calendar').status,
    ).toBe('not_connected');

    const lv = await s.call.patch('/connections/google-calendar', { level: 'auto' }).expect(200);
    expect(app(lv.body, 'google-calendar').level).toBe('auto');
    await s.call.patch('/connections/gmail', { level: 'auto' }).expect(409);
    await s.call.post('/connections/hubspot/connect').expect(422);
  });

  it('lets Jack read the calendar and email when asked', async () => {
    await s.call.post('/connections/gmail/connect').expect(200);
    const { events, answer } = await s.ask(
      'What is on my calendar this week, and anything important in my email?',
    );
    const plan = events.find((e) => e.event === 'plan')!.data.steps;
    expect(plan).toEqual([
      expect.objectContaining({
        tool: 'calendar',
        status: 'done',
        detail: 'Read 4 events in the next 7 days',
      }),
      expect.objectContaining({
        tool: 'email',
        status: 'done',
        detail: 'Read 3 emails from the last 7 days',
      }),
    ]);
    expect(answer.plan).toHaveLength(2);

    // Not connected in Business: Jack doesn't try.
    const biz = await s.ask('What is on my calendar this week?', 'business');
    expect(biz.events.map((e) => e.event)).not.toContain('plan');

    const off = await s.call.delete('/connections/gmail').expect(200);
    expect(app(off.body, 'gmail').status).toBe('not_connected');
  });
});
