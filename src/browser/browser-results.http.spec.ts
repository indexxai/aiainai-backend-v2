import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoLanguageModel } from '../models/demo-model.js';
import { signedInApp } from '../testing/http-session.js';

const until = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 300): Promise<T> => {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 20));
    v = await fn();
  }
  return v;
};

/** What Jack's browser found reaches the person (under its card) and Jack (in later answers). */
describe('Jack’s browser results', () => {
  let s: Awaited<ReturnType<typeof signedInApp>>;
  beforeAll(async () => {
    s = await signedInApp({ email: 'results@example.com' });
  });
  afterAll(async () => s?.close());

  it('shows what the browser found under its card, and Jack knows it on the next message', async () => {
    const { events, chatId } = await s.ask('Find me the best high tea buffet in Lahore');
    const step = events.find((e) => e.event === 'plan')!.data.steps[0];
    expect(step).toMatchObject({ tool: 'browse', status: 'running' });
    const last = () =>
      s.call
        .get(`/chats/${chatId}`)
        .then((r) => r.body.messages.at(-1).plan[0] as { status: string; detail: string; result?: string });
    const done = await until(last, (p) => p.status === 'done');
    expect(done.detail).toBe('Finished · what Jack found is below');
    expect(done.result).toMatch(/Found 6 options/);

    DemoLanguageModel.prompts.length = 0;
    await s.stream(`/chats/${chatId}/messages`, { text: 'What did the browser find?' });
    const seen = DemoLanguageModel.prompts.join('\n');
    expect(seen).toContain('What it found');
    expect(seen).toContain('Found 6 options');
  });

  it('pauses for a security check the person solves, then carries on', async () => {
    const { events, chatId } = await s.ask('Find me the best high tea buffet in Lahore CHECK_DEMO');
    const id = events
      .find((e) => e.event === 'plan')!
      .data.steps[0].href.split('/')
      .pop();
    const task = () => s.call.get(`/browser/${id}`).then((r) => r.body);
    const paused = await until(task, (t) => t.status === 'paused');
    expect(paused.steps.at(-1)).toMatchObject({
      state: 'needs_you',
      text: expect.stringMatching(/security check/),
    });
    const card = (await s.call.get(`/chats/${chatId}`)).body.messages.at(-1).plan[0];
    expect(card).toMatchObject({
      status: 'waiting',
      detail: expect.stringMatching(/security check needs you/),
    });
    // Take over, solve it, give it back: Jack finishes the task.
    await s.call.post(`/browser/${id}/takeover`).expect(200);
    await s.call.post(`/browser/${id}/giveback`).expect(200);
    expect((await until(task, (t) => t.status === 'done')).status).toBe('done');
  });
});
