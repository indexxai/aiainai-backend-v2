import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryApp } from '../testing/memory-app.js';

/** The Connectors chip: apps switched off for a chat aren't used (or mentioned) in it. */
describe('apps per chat over HTTP', () => {
  let app: INestApplication;
  let cookie = '';
  const codes: Record<string, string> = {};
  const origin = { origin: 'http://localhost:3000' };
  const api = () => request(app.getHttpServer());
  const sse = (path: string, body: object) =>
    api()
      .post(`/api${path}`)
      .set('cookie', cookie)
      .set(origin)
      .send(body)
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c.toString()));
        res.on('end', () => cb(null, d));
      })
      .then((r) =>
        String(r.body)
          .split('\n\n')
          .filter((b) => b.startsWith('event:'))
          .map((b) => {
            const [e, data] = b.split('\n');
            return { event: e!.slice(7), data: JSON.parse(data!.slice(6)) };
          }),
      );

  beforeAll(async () => {
    app = await createMemoryApp({ credits: 100, demoDelayMs: 0, onCode: (e, c) => (codes[e] = c) });
    await app.init();
    const email = 'apps@example.com';
    const password = 'correct-horse-9';
    await api().post('/api/auth/sign-up/email').set(origin).send({ name: 'A', email, password }).expect(200);
    await new Promise((r) => setTimeout(r, 20));
    await api()
      .post('/api/auth/email-otp/verify-email')
      .set(origin)
      .send({ email, otp: codes[email] })
      .expect(200);
    const s = await api().post('/api/auth/sign-in/email').set(origin).send({ email, password }).expect(200);
    cookie = (s.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    await api()
      .post('/api/connections/google-calendar/connect')
      .set(origin)
      .set('cookie', cookie)
      .expect(200);
  });
  afterAll(async () => app?.close());

  const tools = async (chatId: string) => {
    const events = await sse(`/chats/${chatId}/messages`, { text: 'What meetings do I have this week?' });
    return (events.find((e) => e.event === 'plan')?.data.steps ?? []).map((s: { tool: string }) => s.tool);
  };

  it('uses a connected app by default, and not when it is switched off for the chat', async () => {
    const on = await api().post('/api/chats').set(origin).set('cookie', cookie).send({}).expect(200);
    expect(on.body.appsOff).toEqual([]);
    expect(await tools(on.body.id)).toEqual(['calendar']);

    const off = await api()
      .post('/api/chats')
      .set(origin)
      .set('cookie', cookie)
      .send({ appsOff: ['google-calendar'] })
      .expect(200);
    expect(off.body.appsOff).toEqual(['google-calendar']);
    expect(await tools(off.body.id)).toEqual([]);

    // Switched back on later in the same chat.
    const back = await api()
      .patch(`/api/chats/${off.body.id}`)
      .set(origin)
      .set('cookie', cookie)
      .send({ appsOff: [] })
      .expect(200);
    expect(back.body.appsOff).toEqual([]);
    expect(await tools(off.body.id)).toEqual(['calendar']);
  });

  it('validates the list', async () => {
    await api().post('/api/chats').set(origin).set('cookie', cookie).send({ appsOff: 'gmail' }).expect(422);
    await api()
      .post('/api/chats')
      .set(origin)
      .set('cookie', cookie)
      .send({ appsOff: Array.from({ length: 31 }, (_, i) => `a${i}`) })
      .expect(422);
  });
});
