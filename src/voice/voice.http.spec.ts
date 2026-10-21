import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryApp } from '../testing/memory-app.js';
import { creditsForSeconds } from './voice.service.js';

/** Voice typing through the real HTTP API with the stand-in speech model. */
describe('voice typing over HTTP', () => {
  let app: INestApplication;
  let cookie = '';
  const codes: Record<string, string> = {};
  const origin = { origin: 'http://localhost:3000' };
  const api = () => request(app.getHttpServer());
  const speak = (bytes: number, type = 'audio/webm;codecs=opus', seconds = 12) =>
    api()
      .post(`/api/voice/transcribe?seconds=${seconds}`)
      .set(origin)
      .set('cookie', cookie)
      .set('content-type', type)
      .send(Buffer.alloc(bytes, 7));
  const credits = async () =>
    (await api().get('/api/me').set('cookie', cookie).expect(200)).body.credits.spendable as number;

  beforeAll(async () => {
    app = await createMemoryApp({ credits: 100, demoDelayMs: 0, onCode: (e, c) => (codes[e] = c) });
    await app.init();
    const email = 'voice@example.com';
    const password = 'correct-horse-9';
    await api().post('/api/auth/sign-up/email').set(origin).send({ name: 'Vo', email, password }).expect(200);
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

  it('charges 1 credit per started minute', () => {
    expect([0, 1, 59, 60, 61, 179, 500].map(creditsForSeconds)).toEqual([1, 1, 1, 1, 2, 3, 3]);
  });

  it('turns a recording into text and charges for it', async () => {
    const before = await credits();
    const res = await speak(4000).expect(200);
    expect(res.body.text).toMatch(/hotels in Dubai/);
    expect(res.body.credits).toBe(1);
    expect(await credits()).toBe(before - 1);
  });

  it('charges nothing when no words were heard', async () => {
    const before = await credits();
    const res = await speak(600).expect(422);
    expect(res.body.error.message).toMatch(/didn’t catch any words/);
    expect(await credits()).toBe(before);
  });

  it('refuses things that are not audio, empty bodies and signed-out callers', async () => {
    await speak(4000, 'image/png').expect(422);
    await speak(0).expect(422);
    await api()
      .post('/api/voice/transcribe')
      .set(origin)
      .set('content-type', 'audio/webm')
      .send(Buffer.alloc(4000))
      .expect(401);
  });

  it('refuses recordings that are too large', async () => {
    const res = await speak(11 * 1024 * 1024);
    expect(res.status).toBe(413);
  });
});
