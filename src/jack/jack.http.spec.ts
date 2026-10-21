import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryApp } from '../testing/memory-app.js';
import { cleanPlan } from './jack.logic.js';

/** Jack's tools in a conversation, through the real HTTP API (in-memory storage, stand-in model). */
describe('Jack uses his tools in a conversation', () => {
  let app: INestApplication;
  let cookie = '';
  const codes: Record<string, string> = {};
  const api = () => request(app.getHttpServer());
  const origin = { origin: 'http://localhost:3000' };

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
    app = await createMemoryApp({
      credits: 200,
      demoDelayMs: 0,
      demoImageDelayMs: 50,
      onCode: (e, c) => (codes[e] = c),
    });
    await app.init();
    const email = 'jack@example.com';
    const password = 'correct-horse-9';
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

  it('starts a document and images, says so, and the plan follows them to done', async () => {
    const chat = await api().post('/api/chats').set('cookie', cookie).set(origin).send({}).expect(200);
    const events = await sse(`/chats/${chat.body.id}/messages`, {
      text: 'Write a trip checklist document for Dubai and make 2 poster images of the skyline',
    });
    const names = events.map((e) => e.event);
    expect(names.slice(0, 2)).toEqual(['ready', 'plan']);
    expect(names.at(-1)).toBe('done');
    const plan = events.find((e) => e.event === 'plan')!.data.steps;
    expect(plan.map((s: { tool: string }) => s.tool)).toEqual(['doc', 'image']);
    expect(plan[0]).toMatchObject({ status: 'running', detail: 'Writing in AI Docs' });
    expect(plan[0].href).toMatch(/^\/docs\/[a-f0-9]{24}$/);
    expect(plan[1]).toMatchObject({ status: 'running', href: expect.stringMatching(/^\/image\//) });

    const done = events.at(-1)!.data.message;
    expect(done.content.length).toBeGreaterThan(0);
    expect(done.plan).toHaveLength(2);

    // The document and images keep going after the answer; the conversation shows them finished.
    let steps: { tool: string; status: string; detail: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const detail = await api().get(`/api/chats/${chat.body.id}`).set('cookie', cookie).expect(200);
      steps = detail.body.messages.at(-1).plan;
      if (steps.every((s) => s.status === 'done')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(steps).toEqual([
      expect.objectContaining({ tool: 'doc', status: 'done', detail: 'Ready to edit in AI Docs' }),
      expect.objectContaining({ tool: 'image', status: 'done', detail: '2 images ready in AI Image' }),
    ]);

    // They are in AI Docs and AI Image like anything else, marked as made by Jack.
    const docs = (await app.get(getModelToken('DocumentRecord')).find({}).lean()) as { madeBy?: string }[];
    expect(docs.map((d) => d.madeBy)).toEqual(['jack']);
    const imgs = (await app.get(getModelToken('ImageGeneration')).find({}).lean()) as { madeBy?: string }[];
    expect(imgs.map((d) => d.madeBy)).toEqual(['jack']);
  });

  it('answers plainly when no tool is needed', async () => {
    const chat = await api().post('/api/chats').set('cookie', cookie).set(origin).send({}).expect(200);
    const events = await sse(`/chats/${chat.body.id}/messages`, { text: 'What is the capital of France?' });
    expect(events.map((e) => e.event)).not.toContain('plan');
    expect(events.at(-1)!.data.message.plan).toEqual([]);
  });

  it('keeps tools that aren’t connected out of the plan, and each tool at most once', () => {
    const step = (tool: 'doc' | 'image' | 'email') => ({
      tool,
      title: 'x',
      brief: 'y',
      docType: 'other' as const,
      count: 1,
      to: '',
      when: '',
    });
    const none = { calendar: false, email: false, browser: false, drive: false, slack: false };
    expect(cleanPlan({ jackSteps: [step('email'), step('doc'), step('doc')] }, none)).toEqual([step('doc')]);
    expect(cleanPlan({ jackSteps: [step('email')] }, { ...none, email: true })).toEqual([step('email')]);
  });
});
