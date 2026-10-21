import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayService, type GatewayRequest } from '../gateway/gateway.service.js';
import { createMemoryApp } from '../testing/memory-app.js';

/** Projects over HTTP: group chats, docs and files; Jack reads the project's instructions and files. */
describe('projects over HTTP', () => {
  let app: INestApplication;
  const codes: Record<string, string> = {};
  const origin = { origin: 'http://localhost:3000' };
  const api = () => request(app.getHttpServer());
  const seen: GatewayRequest[] = [];
  let a = '';
  let b = '';

  const signUp = async (email: string) => {
    const password = 'correct-horse-9';
    const ip = { 'x-forwarded-for': email };
    await api()
      .post('/api/auth/sign-up/email')
      .set(origin)
      .set(ip)
      .send({ name: 'P', email, password })
      .expect(200);
    await new Promise((r) => setTimeout(r, 20));
    await api()
      .post('/api/auth/email-otp/verify-email')
      .set(origin)
      .set(ip)
      .send({ email, otp: codes[email] })
      .expect(200);
    const res = await api()
      .post('/api/auth/sign-in/email')
      .set(origin)
      .set(ip)
      .send({ email, password })
      .expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  };
  const send = (cookie: string, method: 'post' | 'patch' | 'delete', path: string, body?: object) =>
    api()[method](`/api${path}`).set(origin).set('cookie', cookie).send(body);
  const get = (cookie: string, path: string) => api().get(`/api${path}`).set('cookie', cookie);
  const say = (cookie: string, chatId: string, text: string) =>
    api()
      .post(`/api/chats/${chatId}/messages`)
      .set(origin)
      .set('cookie', cookie)
      .send({ text })
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c.toString()));
        res.on('end', () => cb(null, d));
      });

  beforeAll(async () => {
    app = await createMemoryApp({ credits: 100, demoDelayMs: 0, onCode: (e, c) => (codes[e] = c) });
    await app.init();
    const gw = app.get(GatewayService);
    const original = gw.stream.bind(gw);
    gw.stream = (req: GatewayRequest) => {
      seen.push(req);
      return original(req);
    };
    a = await signUp('proj-a@example.com');
    b = await signUp('proj-b@example.com');
  });
  afterAll(async () => app?.close());

  it('creates, lists, renames and validates projects', async () => {
    const p = await send(a, 'post', '/projects', {
      name: '  Dubai trip ',
      instructions: 'Budget is 2,000 dollars.',
    }).expect(200);
    expect(p.body).toMatchObject({
      name: 'Dubai trip',
      instructions: 'Budget is 2,000 dollars.',
      chatCount: 0,
    });
    await send(a, 'post', '/projects', { name: '   ' }).expect(422);
    await send(a, 'post', '/projects', { name: 'x'.repeat(121) }).expect(422);
    await send(a, 'patch', `/projects/${p.body.id}`, {}).expect(422);
    const renamed = await send(a, 'patch', `/projects/${p.body.id}`, { name: 'Dubai holiday' }).expect(200);
    expect(renamed.body.name).toBe('Dubai holiday');
    const list = await get(a, '/projects').expect(200);
    expect(list.body.map((x: { name: string }) => x.name)).toEqual(['Dubai holiday']);
  });

  it('starts chats in a project, where Jack reads its instructions and files', async () => {
    const p = (
      await send(a, 'post', '/projects', {
        name: 'Launch',
        instructions: 'Always answer in bullet points.',
      }).expect(200)
    ).body;
    const file = await api()
      .post(`/api/files?name=brief.txt&projectId=${p.id}`)
      .set(origin)
      .set('cookie', a)
      .set('content-type', 'text/plain')
      .send(Buffer.from('Launch date is 3 March.'))
      .expect(200);
    expect(file.body.projectId).toBe(p.id);
    const chat = await send(a, 'post', '/chats', { projectId: p.id }).expect(200);
    expect(chat.body.projectId).toBe(p.id);
    await say(a, chat.body.id, 'When do we launch?').expect(200);
    const sys = seen.at(-1)!.system!;
    expect(sys).toMatch(/project “Launch”/);
    expect(sys).toMatch(/Always answer in bullet points/);
    expect(sys).toMatch(/Launch date is 3 March/);

    const detail = await get(a, `/chats/${chat.body.id}`).expect(200);
    expect(detail.body.project).toEqual({ id: p.id, name: 'Launch' });
    const proj = await get(a, `/projects/${p.id}`).expect(200);
    expect(proj.body.chats.map((c: { id: string }) => c.id)).toEqual([chat.body.id]);
    expect(proj.body.files.map((f: { name: string }) => f.name)).toEqual(['brief.txt']);
    expect(proj.body.project).toMatchObject({ chatCount: 1, fileCount: 1 });
  });

  it('moves items in and out, and keeps them when the project is deleted', async () => {
    const p = (await send(a, 'post', '/projects', { name: 'Moves' }).expect(200)).body;
    const chat = (await send(a, 'post', '/chats', {}).expect(200)).body;
    await send(a, 'post', `/projects/${p.id}/items`, { kind: 'chat', id: chat.id }).expect(204);
    expect((await get(a, `/projects/${p.id}`)).body.chats).toHaveLength(1);
    await send(a, 'post', `/projects/${p.id}/items/remove`, { kind: 'chat', id: chat.id }).expect(204);
    expect((await get(a, `/projects/${p.id}`)).body.chats).toHaveLength(0);
    await send(a, 'post', `/projects/${p.id}/items`, { kind: 'chat', id: chat.id }).expect(204);
    await send(a, 'post', `/projects/${p.id}/items`, { kind: 'doc', id: 'nope' }).expect(404);
    await send(a, 'post', `/projects/${p.id}/items`, { kind: 'video', id: chat.id }).expect(422);

    await send(a, 'delete', `/projects/${p.id}`).expect(204);
    await get(a, `/projects/${p.id}`).expect(404);
    const kept = await get(a, `/chats/${chat.id}`).expect(200);
    expect(kept.body.chat.projectId).toBeNull();
    expect(kept.body.project).toBeNull();
  });

  it('keeps projects private to their owner', async () => {
    const p = (await send(a, 'post', '/projects', { name: 'Private' }).expect(200)).body;
    const chatA = (await send(a, 'post', '/chats', {}).expect(200)).body;
    const chatB = (await send(b, 'post', '/chats', {}).expect(200)).body;
    expect((await get(b, '/projects').expect(200)).body).toEqual([]);
    await get(b, `/projects/${p.id}`).expect(404);
    await send(b, 'patch', `/projects/${p.id}`, { name: 'Mine' }).expect(404);
    await send(b, 'delete', `/projects/${p.id}`).expect(404);
    await send(b, 'post', '/chats', { projectId: p.id }).expect(404);
    await send(b, 'post', `/projects/${p.id}/items`, { kind: 'chat', id: chatB.id }).expect(404);
    // A can't pull B's chat into A's project either.
    await send(a, 'post', `/projects/${p.id}/items`, { kind: 'chat', id: chatB.id }).expect(404);
    await send(a, 'post', `/projects/${p.id}/items`, { kind: 'chat', id: chatA.id }).expect(204);
  });
});
