import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signedInApp } from '../testing/http-session.js';
import { memoryContext, memoryKey } from './memory.logic.js';

describe('Memory over HTTP', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  beforeAll(async () => {
    s = await signedInApp({ email: 'memory@example.com' });
    await s.addBusiness();
  });
  afterAll(async () => s?.close());

  it('adds, edits and forgets, kept per space, without duplicates', async () => {
    const added = await s.call
      .post('/memory', { text: 'prefers aisle seats', group: 'preferences' })
      .expect(200);
    expect(added.body).toMatchObject({ text: 'Prefers aisle seats', group: 'preferences', source: 'you' });
    const again = await s.call
      .post('/memory', { text: 'Prefers aisle seats.', group: 'preferences' })
      .expect(200);
    expect(again.body.id).toBe(added.body.id);

    expect((await s.call.get('/memory', 'business').expect(200)).body.items).toEqual([]);
    await s.call
      .post('/memory', { text: 'We roof houses in Lahore', group: 'about' }, 'business')
      .expect(200);
    expect((await s.call.get('/memory', 'personal').expect(200)).body.items).toHaveLength(1);

    const edited = await s.call
      .patch(`/memory/${added.body.id}`, { text: 'Prefers window seats' })
      .expect(200);
    expect(edited.body.text).toBe('Prefers window seats');
    // Can't edit or forget another space's memory.
    await s.call.delete(`/memory/${added.body.id}`, 'business').expect(404);
    await s.call.delete(`/memory/${added.body.id}`).expect(204);
    expect((await s.call.get('/memory').expect(200)).body.items).toEqual([]);
    await s.call.post('/memory', { text: '', group: 'about' }).expect(422);
  });

  it('learns lasting facts from a message, shows them on the answer, and stops when switched off', async () => {
    const { answer } = await s.ask(
      'I live in Lahore and I prefer morning flights. Find me a flight to Dubai.',
    );
    expect(answer.learned.map((l: { text: string }) => l.text)).toEqual([
      'Lives in Lahore',
      'Prefers morning flights',
    ]);
    const list = (await s.call.get('/memory').expect(200)).body;
    expect(list.items.map((m: { source: string; group: string }) => `${m.source}:${m.group}`).sort()).toEqual(
      ['jack:about', 'jack:preferences'],
    );

    // Forget from the answer: same endpoint.
    await s.call.delete(`/memory/${answer.learned[0].id}`).expect(204);
    await s.call.delete(`/memory/${answer.learned[1].id}`).expect(204);

    await s.call.patch('/memory/settings', { enabled: false }).expect(200);
    const off = await s.ask('My mum’s birthday is on Saturday.');
    expect(off.answer.learned).toEqual([]);
    expect((await s.call.get('/memory').expect(200)).body).toMatchObject({ enabled: false, items: [] });
    await s.call.patch('/memory/settings', { enabled: true }).expect(200);
    const on = await s.ask('My mum is turning 60 on Saturday.');
    expect(on.answer.learned.map((l: { text: string }) => l.text)).toEqual(['Mum — turning 60 on Saturday']);
  });

  it('tells Jack what he knows, without asking him to recite it', () => {
    const ctx = memoryContext([{ text: 'Lives in Lahore', group: 'about' }], 'personal');
    expect(ctx).toContain('- (About you) Lives in Lahore');
    expect(ctx).toMatch(/never recite it/);
    expect(memoryContext([], 'personal')).toBe('');
    expect(memoryKey('Lives in Lahore!')).toBe(memoryKey('lives in  lahore'));
  });
});
