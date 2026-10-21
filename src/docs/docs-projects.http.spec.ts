import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayService, type GatewayRequest } from '../gateway/gateway.service.js';
import { createMemoryApp } from '../testing/memory-app.js';

/** Documents in a project: made from inside it, and written with its instructions and files. */
describe('documents in projects over HTTP', () => {
  let app: INestApplication;
  const codes: Record<string, string> = {};
  const origin = { origin: 'http://localhost:3000' };
  const api = () => request(app.getHttpServer());
  const seen: { kind: 'object' | 'stream'; req: GatewayRequest }[] = [];
  let a = '';
  let b = '';

  const signUp = async (email: string) => {
    const password = 'correct-horse-9';
    const ip = { 'x-forwarded-for': email };
    await api()
      .post('/api/auth/sign-up/email')
      .set(origin)
      .set(ip)
      .send({ name: 'D', email, password })
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
  const send = (cookie: string, method: 'post' | 'patch', path: string, body?: object) =>
    api()[method](`/api${path}`).set(origin).set('cookie', cookie).send(body);
  const get = (cookie: string, path: string) => api().get(`/api${path}`).set('cookie', cookie);
  const stream = (cookie: string, path: string, body: object = {}) =>
    api()
      .post(`/api${path}`)
      .set(origin)
      .set('cookie', cookie)
      .send(body)
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c.toString()));
        res.on('end', () => cb(null, d));
      });

  const project = async () => {
    const p = (
      await send(a, 'post', '/projects', {
        name: 'Launch',
        instructions: 'Write in British English.',
      }).expect(200)
    ).body;
    await api()
      .post(`/api/files?name=brief.txt&projectId=${p.id}`)
      .set(origin)
      .set('cookie', a)
      .set('content-type', 'text/plain')
      .send(Buffer.from('Launch date is 3 March.'))
      .expect(200);
    return p as { id: string };
  };

  beforeAll(async () => {
    app = await createMemoryApp({ credits: 200, demoDelayMs: 0, onCode: (e, c) => (codes[e] = c) });
    await app.init();
    const gw = app.get(GatewayService);
    const object = gw.object.bind(gw);
    const original = gw.stream.bind(gw);
    gw.object = ((req: GatewayRequest & { schema: unknown }) => {
      seen.push({ kind: 'object', req });
      return object(req as never);
    }) as typeof gw.object;
    gw.stream = (req: GatewayRequest) => {
      seen.push({ kind: 'stream', req });
      return original(req);
    };
    a = await signUp('docproj-a@example.com');
    b = await signUp('docproj-b@example.com');
  });
  afterAll(async () => app?.close());

  it('makes a document inside a project and writes it with the project’s instructions and files', async () => {
    const p = await project();

    await send(a, 'post', '/docs/outline', {
      brief: 'A launch plan for the team',
      type: 'plan',
      projectId: p.id,
    }).expect(200);
    const outline = seen.filter((s) => s.kind === 'object').at(-1)!.req.system!;
    expect(outline).toMatch(/project “Launch”/);
    expect(outline).toMatch(/Write in British English/);
    expect(outline).toMatch(/Launch date is 3 March/);

    const doc = await send(a, 'post', '/docs', {
      title: 'Launch plan',
      type: 'plan',
      sections: [{ heading: 'Timeline', note: '' }],
      length: 'short',
      projectId: p.id,
    }).expect(200);
    expect(doc.body.project).toEqual({ id: p.id, name: 'Launch' });

    await stream(a, `/docs/${doc.body.id}/write`).expect(200);
    const write = seen.filter((s) => s.kind === 'stream').at(-1)!.req.system!;
    expect(write).toMatch(/Write in British English/);
    expect(write).toMatch(/Launch date is 3 March/);

    const detail = await get(a, `/projects/${p.id}`).expect(200);
    expect(detail.body.docs.map((d: { id: string }) => d.id)).toContain(doc.body.id);
    expect((await get(a, `/docs/${doc.body.id}`).expect(200)).body.project).toEqual({
      id: p.id,
      name: 'Launch',
    });
  });

  it('a blank document made in a project lands there too', async () => {
    const p = await project();
    const doc = await send(a, 'post', '/docs', {
      title: 'Notes',
      type: 'plan',
      sections: [],
      projectId: p.id,
    }).expect(200);
    expect(doc.body.project).toEqual({ id: p.id, name: 'Launch' });
  });

  it('documents outside a project carry no project text', async () => {
    const doc = await send(a, 'post', '/docs', {
      title: 'Loose',
      type: 'plan',
      sections: [{ heading: 'One', note: '' }],
      length: 'short',
    }).expect(200);
    expect(doc.body.project).toBeNull();
    await stream(a, `/docs/${doc.body.id}/write`).expect(200);
    expect(seen.filter((s) => s.kind === 'stream').at(-1)!.req.system!).not.toMatch(/PROJECT:/);
  });

  it('someone else’s project is a 404', async () => {
    const p = await project();
    await send(b, 'post', '/docs', { title: 'X', type: 'plan', sections: [], projectId: p.id }).expect(404);
    await send(b, 'post', '/docs/outline', { brief: 'Something', type: 'plan', projectId: p.id }).expect(404);
    await send(a, 'post', '/docs', { title: 'X', type: 'plan', sections: [], projectId: 'nope' }).expect(404);
  });

  it('a document Jack writes from a project chat goes in that project', async () => {
    const p = await project();
    const chat = await send(a, 'post', '/chats', { projectId: p.id }).expect(200);
    await stream(a, `/chats/${chat.body.id}/messages`, { text: 'Write a launch checklist document' }).expect(
      200,
    );
    const detail = await get(a, `/projects/${p.id}`).expect(200);
    expect(detail.body.docs).toHaveLength(1);
  });
});
