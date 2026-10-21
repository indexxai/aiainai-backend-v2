import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { createMemoryApp, type MemoryAppOptions } from './memory-app.js';

/**
 * The in-memory API with one signed-up, verified person, and helpers to call it as them
 * (optionally in a space) and to read streamed answers. For HTTP-level tests.
 */
export async function signedInApp(opts: MemoryAppOptions & { email?: string } = {}) {
  const codes: Record<string, string> = {};
  const app: INestApplication = await createMemoryApp({
    credits: 200,
    demoDelayMs: 0,
    demoImageDelayMs: 50,
    browserStepMs: 5,
    ...opts,
    onCode: (e, c) => (codes[e] = c),
  });
  await app.init();
  const origin = 'http://localhost:3000';
  const email = opts.email ?? 'person@example.com';
  const password = 'correct-horse-9';
  const api = () => request(app.getHttpServer());
  await api()
    .post('/api/auth/sign-up/email')
    .set('origin', origin)
    .send({ name: 'Indexx', email, password })
    .expect(200);
  await new Promise((r) => setTimeout(r, 20));
  await api()
    .post('/api/auth/email-otp/verify-email')
    .set('origin', origin)
    .send({ email, otp: codes[email] })
    .expect(200);
  const signIn = await api()
    .post('/api/auth/sign-in/email')
    .set('origin', origin)
    .send({ email, password })
    .expect(200);
  const cookie = (signIn.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

  type Space = 'personal' | 'business';
  const as = (t: request.Test, space?: Space) => {
    t.set('cookie', cookie).set('origin', origin);
    return space ? t.set('x-aiainai-space', space) : t;
  };
  const call = {
    get: (path: string, space?: Space) => as(api().get(`/api${path}`), space),
    post: (path: string, body: object = {}, space?: Space) => as(api().post(`/api${path}`), space).send(body),
    put: (path: string, body: object = {}, space?: Space) => as(api().put(`/api${path}`), space).send(body),
    patch: (path: string, body: object = {}, space?: Space) =>
      as(api().patch(`/api${path}`), space).send(body),
    delete: (path: string, space?: Space) => as(api().delete(`/api${path}`), space),
  };

  /** POST a streaming endpoint and return its events. */
  const stream = async (path: string, body: object, space?: Space) => {
    const r = await as(api().post(`/api${path}`), space)
      .send(body)
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c.toString()));
        res.on('end', () => cb(null, d));
      });
    return String(r.body)
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => {
        const [e, data] = b.split('\n');
        return { event: e!.slice(7), data: JSON.parse(data!.slice(6)) };
      });
  };

  /** Start a chat and send one message; returns the events and the chat id. */
  const ask = async (text: string, space?: Space) => {
    const chat = await call.post('/chats', {}, space).expect(200);
    const events = await stream(`/chats/${chat.body.id}/messages`, { text }, space);
    return { chatId: chat.body.id as string, events, answer: events.at(-1)!.data.message };
  };

  /**
   * Give the person a Business space (there is no set-up screen any more; Captain Jack is coming
   * soon), stored directly so tests can check the two spaces stay apart.
   */
  const addBusiness = async (name = 'Skyline Roofing') => {
    const spaces = await call.get('/spaces').expect(200);
    const workspaces = app.get(getModelToken('Workspace'));
    const personal = await workspaces.findById(spaces.body.personal.id).lean();
    await workspaces.create({
      name,
      ownerUserId: personal.ownerUserId,
      kind: 'business',
      parentWorkspaceId: new Types.ObjectId(String(personal._id)),
      plan: personal.plan,
      periodStart: personal.periodStart,
      periodEnd: personal.periodEnd,
      business: {},
    });
  };

  return { app, call, stream, ask, addBusiness, close: () => app.close() };
}
