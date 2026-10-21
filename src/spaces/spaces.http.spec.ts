import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getModelToken } from '@nestjs/mongoose';
import { createMemoryApp } from '../testing/memory-app.js';

/**
 * Personal and Business spaces through the real HTTP API (in-memory storage, stand-in model):
 * the space header picks the workspace, data never crosses, and credits come from one plan.
 */
describe('spaces over HTTP', () => {
  let app: INestApplication;
  let cookie = '';
  const codes: Record<string, string> = {};
  const api = () => request(app.getHttpServer());
  const as = (space?: 'personal' | 'business') => (r: request.Test) =>
    space ? r.set('cookie', cookie).set('x-aiainai-space', space) : r.set('cookie', cookie);
  const get = (path: string, space?: 'personal' | 'business') => as(space)(api().get(`/api${path}`));
  const send = (
    method: 'post' | 'put' | 'patch',
    path: string,
    body: object,
    space?: 'personal' | 'business',
  ) => as(space)(api()[method](`/api${path}`).set('origin', 'http://localhost:3000').send(body));

  beforeAll(async () => {
    app = await createMemoryApp({ credits: 100, demoDelayMs: 0, onCode: (e, c) => (codes[e] = c) });
    await app.init();
    const email = 'space@example.com';
    const password = 'correct-horse-9';
    const origin = { origin: 'http://localhost:3000' };
    await api()
      .post('/api/auth/sign-up/email')
      .set(origin)
      .send({ name: 'Indexx', email, password })
      .expect(200);
    await new Promise((r) => setTimeout(r, 20));
    await api()
      .post('/api/auth/email-otp/verify-email')
      .set(origin)
      .send({ email, otp: codes[email] })
      .expect(200);
    const signIn = await api()
      .post('/api/auth/sign-in/email')
      .set(origin)
      .send({ email, password })
      .expect(200);
    cookie = (signIn.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  });

  afterAll(async () => app?.close());

  it('starts in Personal with no Business space; asking for Business falls back to Personal', async () => {
    const res = await get('/spaces', 'business').expect(200);
    expect(res.body).toMatchObject({ active: 'personal', business: null });
    expect(res.body.providers.map((p: { id: string }) => p.id)).toContain('deepseek');
    const me = await get('/me').expect(200);
    expect(me.body.space).toEqual({ active: 'personal', business: null });
  });

  it('keeps Business chats apart, and spends from the one plan', async () => {
    const personalChat = await send('post', '/chats', {}, 'personal').expect(200);

    // There is no Business set-up screen any more (Captain Jack is coming soon); add one directly.
    const workspaces = app.get(getModelToken('Workspace'));
    const me = await get('/spaces', 'personal').expect(200);
    const personal = await workspaces.findById(me.body.personal.id).lean();
    const created = await workspaces.create({
      name: 'indexx.ai',
      ownerUserId: personal.ownerUserId,
      kind: 'business',
      parentWorkspaceId: personal._id,
      plan: personal.plan,
      periodStart: personal.periodStart,
      periodEnd: personal.periodEnd,
      business: { helpWith: ['leads'] },
    });
    const saved = { body: { id: String(created._id) } };

    const spaces = await get('/spaces', 'business').expect(200);
    expect(spaces.body.active).toBe('business');
    expect(spaces.body.business.id).toBe(saved.body.id);
    // The cookie works too (the web app sets it when the person switches).
    const viaCookie = await api()
      .get('/api/me')
      .set('cookie', `${cookie}; aiainai_space=business`)
      .expect(200);
    expect(viaCookie.body.space).toEqual({
      active: 'business',
      business: { id: saved.body.id, name: 'indexx.ai' },
    });

    expect((await get('/chats', 'business').expect(200)).body.items).toEqual([]);
    const bizChat = await send('post', '/chats', {}, 'business').expect(200);
    const personalList = (await get('/chats', 'personal').expect(200)).body.items.map(
      (c: { id: string }) => c.id,
    );
    expect(personalList).toEqual([personalChat.body.id]);
    // A Business chat can't be opened from Personal.
    await get(`/chats/${bizChat.body.id}`, 'personal').expect(404);

    // Business answers are paid from the Personal plan; usage remembers the space.
    const before = (await get('/me').expect(200)).body.credits.spendable;
    await send('post', `/chats/${bizChat.body.id}/messages`, { text: 'Hello Jack' }, 'business').expect(200);
    const after = (await get('/me', 'business').expect(200)).body.credits.spendable;
    expect(after).toBeLessThan(before);
    const usage = app.get(getModelToken('UsageEvent'));
    const rows = (await usage.find({}).lean()) as { workspaceId: unknown; spaceWorkspaceId?: unknown }[];
    expect(rows.some((r) => String(r.spaceWorkspaceId) === saved.body.id)).toBe(true);
    expect(rows.every((r) => String(r.workspaceId) !== saved.body.id)).toBe(true);
  });

  it('shows Jack’s home per space with starter suggestions', async () => {
    const personal = await get('/home', 'personal').expect(200);
    const business = await get('/home', 'business').expect(200);
    expect(personal.body).toMatchObject({ space: 'personal', needsYou: [], inProgress: [] });
    expect(business.body.space).toBe('business');
    expect(business.body.suggestions[0].text).toMatch(/leads/);
  });
});
