import { getModelToken } from '@nestjs/mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedInApp } from '../testing/http-session.js';

/** The sign-up screen "What will you use Jack for?": asked once, for new accounts only. */
describe('onboarding over HTTP', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  beforeAll(async () => {
    s = await signedInApp({ email: 'onboard@example.com' });
  });
  afterAll(() => s.close());

  it('asks a new account, saves the answer, and stops asking', async () => {
    const before = await s.call.get('/me').expect(200);
    expect(before.body.onboarding).toEqual({ askUse: true, use: null, goals: [], note: '' });

    const saved = await s.call.patch('/me/onboarding', { use: 'business' }).expect(200);
    expect(saved.body).toEqual({ askUse: false, use: 'business', goals: [], note: '' });

    const after = await s.call.get('/me').expect(200);
    expect(after.body.onboarding).toEqual({ askUse: false, use: 'business', goals: [], note: '' });
    // Picking Business does not set up a Business space; that is the next screen's job.
    expect(after.body.space).toEqual({ active: 'personal', business: null });
  });

  it('lets the answer change (Personal after Business)', async () => {
    const saved = await s.call.patch('/me/onboarding', { use: 'personal' }).expect(200);
    expect(saved.body).toMatchObject({ askUse: false, use: 'personal' });
  });

  it('saves what Jack should help with first, and keeps the earlier answer', async () => {
    const saved = await s.call
      .patch('/me/onboarding', {
        goals: ['Travel and trips', 'Research', 'Research'],
        note: ' Plan my wedding ',
      })
      .expect(200);
    expect(saved.body).toEqual({
      askUse: false,
      use: 'personal',
      goals: ['Travel and trips', 'Research'],
      note: 'Plan my wedding',
    });
    await s.call.patch('/me/onboarding', { goals: Array(13).fill('x') }).expect(422);
    await s.call.patch('/me/onboarding', { note: 'x'.repeat(301) }).expect(422);
  });

  it('rejects anything other than personal or business', async () => {
    await s.call.patch('/me/onboarding', { use: 'pending' }).expect(422);
    await s.call.patch('/me/onboarding', { use: 'personal', extra: 1 }).expect(422);
    await s.call.patch('/me/onboarding', {}).expect(422);
  });

  it('never asks accounts made before the screen existed', async () => {
    const profiles = s.app.get(getModelToken('UserProfile'));
    await profiles.updateMany({}, { $set: { onboarding: {} } });
    const me = await s.call.get('/me').expect(200);
    expect(me.body.onboarding).toEqual({ askUse: false, use: null, goals: [], note: '' });
  });
});
