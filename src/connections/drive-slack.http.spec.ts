import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayService, type GatewayRequest } from '../gateway/gateway.service.js';
import { signedInApp } from '../testing/http-session.js';
import { CONNECTOR } from './connector.js';
import type { DemoConnector } from './demo-connector.js';

/** Google Drive and Slack (stand-in connector), and Gmail sending on its own. */
describe('Google Drive, Slack and Gmail sending over HTTP', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  const seen: GatewayRequest[] = [];
  let outbox: DemoConnector['outbox'];

  beforeAll(async () => {
    s = await signedInApp({ email: 'drive-slack@example.com' });
    const gw = s.app.get(GatewayService);
    const original = gw.stream.bind(gw);
    gw.stream = (req: GatewayRequest) => {
      seen.push(req);
      return original(req);
    };
    outbox = (s.app.get(CONNECTOR) as DemoConnector).outbox;
  });
  afterAll(async () => s?.close());

  const app = (body: { apps: { id: string }[] }, id: string) =>
    body.apps.find((a) => a.id === id) as unknown as { status: string; level: string; levels: string[] };
  const plan = (r: Awaited<ReturnType<typeof s.ask>>) => r.events.find((e) => e.event === 'plan')?.data.steps;

  it('lists Drive and Slack with the levels each allows', async () => {
    const list = (await s.call.get('/connections').expect(200)).body;
    expect(list.apps.map((a: { id: string }) => a.id)).toEqual([
      'gmail',
      'google-calendar',
      'google-drive',
      'slack',
      'outlook',
    ]);
    expect(app(list, 'google-drive')).toMatchObject({
      status: 'not_connected',
      level: 'read',
      levels: ['read'],
    });
    expect(app(list, 'slack')).toMatchObject({ level: 'ask', levels: ['read', 'ask', 'auto'] });
    expect(app(list, 'gmail').levels).toEqual(['read', 'draft', 'ask', 'auto']);

    await s.call.post('/connections/google-drive/connect').expect(200);
    await s.call.post('/connections/slack/connect').expect(200);
    await s.call.patch('/connections/google-drive', { level: 'ask' }).expect(422);
    await s.call.patch('/connections/slack', { level: 'draft' }).expect(422);
  });

  it('Jack searches Drive and reads the matching file', async () => {
    const r = await s.ask('Find the sales numbers in my Drive');
    expect(plan(r)).toEqual([
      expect.objectContaining({
        tool: 'drive',
        status: 'done',
        detail: 'Found 1 file, read Q3 sales report',
      }),
    ]);
    expect(seen.at(-1)!.system).toMatch(/Q3 sales were 128,000 dollars/);
  });

  it('Jack reads Slack, all channels or one', async () => {
    const all = await s.ask('Anything new in Slack?');
    expect(plan(all)[0]).toMatchObject({
      tool: 'slack',
      status: 'done',
      detail: 'Read 3 messages from the last 7 days',
    });
    expect(seen.at(-1)!.system).toMatch(/team lunch on Friday/);

    const one = await s.ask('What did people say in Slack #sales?');
    expect(plan(one)[0]).toMatchObject({
      status: 'done',
      detail: 'Read 2 messages in #sales from the last 7 days',
    });
    expect(seen.at(-1)!.system).not.toMatch(/team lunch/);

    const none = await s.ask('What is new in Slack #nowhere?');
    expect(plan(none)[0]).toMatchObject({
      status: 'failed',
      detail: 'There’s no Slack channel called #nowhere that you’re in.',
    });
  });

  it('Slack messages wait for an OK at Ask first and post at On its own', async () => {
    const r = await s.ask('Post in Slack #sales saying the Model Town quote went out today');
    const step = plan(r)[0];
    expect(step).toMatchObject({ tool: 'send_slack', status: 'waiting', action: { kind: 'slack_message' } });
    const before = outbox.length;
    const ok = await s.call
      .post(`/approvals/jack/${step.action.id}/approve`, { body: 'Quote sent to Model Town.' })
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'done', result: 'Posted in #sales.' });
    expect(outbox.slice(before)).toEqual([
      { kind: 'slack', data: { channel: 'sales', text: 'Quote sent to Model Town.' } },
    ]);

    await s.call.patch('/connections/slack', { level: 'auto' }).expect(200);
    const auto = await s.ask('Send a Slack message to #general saying lunch is moved to 2pm');
    expect(plan(auto)[0]).toMatchObject({ status: 'done', detail: 'Posted in #general' });
    expect(outbox.at(-1)).toEqual({
      kind: 'slack',
      data: { channel: 'general', text: 'Lunch is moved to 2pm' },
    });

    await s.call.patch('/connections/slack', { level: 'read' }).expect(200);
    const ro = await s.ask('Post in Slack #general saying hello');
    expect(plan(ro)[0]).toMatchObject({
      status: 'skipped',
      detail: 'Slack is set to Read only. Change it in Connections.',
    });
  });

  it('Gmail at On its own sends straight away', async () => {
    await s.call.post('/connections/gmail/connect').expect(200);
    await s.call.patch('/connections/gmail', { level: 'auto' }).expect(200);
    const r = await s.ask('Send an email to bob@example.com about the roof quote');
    expect(plan(r)[0]).toMatchObject({
      tool: 'send_email',
      status: 'done',
      detail: 'Sent from your Gmail to bob@example.com',
    });
    expect(outbox.at(-1)).toMatchObject({
      kind: 'email',
      data: { to: 'bob@example.com', subject: 'The roof quote' },
    });
  });

  it('switching an app off for a chat keeps Jack out of it', async () => {
    const chat = (await s.call.post('/chats', { appsOff: ['slack', 'google-drive'] }).expect(200)).body;
    const events = await s.stream(`/chats/${chat.id}/messages`, {
      text: 'Anything new in Slack or my Drive files?',
    });
    expect(events.map((e) => e.event)).not.toContain('plan');
  });
});
