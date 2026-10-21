import { Logger } from '@nestjs/common';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { CreditsService } from '../credits/credits.service.js';
import { ChatSchema, MessageSchema, type Chat, type Message } from '../database/schemas/chat.schema.js';
import { UsageEventSchema, type UsageEvent } from '../database/schemas/usage-event.schema.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { DemoLanguageModel } from '../models/demo-model.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { MemoryModel } from '../testing/memory-model.js';
import { liveRuns, runKey } from '../common/live-runs.js';
import { MAX_ANSWER_TOKENS } from './chat.logic.js';
import { Project, ProjectSchema } from '../database/schemas/project.schema.js';
import { ChatsService, type Actor, type StreamEvent } from './chats.service.js';

Logger.overrideLogger(false);

function setup(balance = 100) {
  const models = modelsService(seedRows(), { AI_DEMO: true });
  const lm = vi
    .spyOn(models.providers, 'languageModel')
    .mockImplementation((m) => new DemoLanguageModel(m.key, m.name, 0));
  const credits = new FakeCredits(balance);
  const usage = new MemoryModel('UsageEvent', UsageEventSchema);
  const gateway = new GatewayService(
    models,
    credits as unknown as CreditsService,
    usage as unknown as Model<UsageEvent>,
  );
  const chats = new MemoryModel('Chat', ChatSchema);
  const messages = new MemoryModel('Message', MessageSchema);
  const svc = new ChatsService(
    chats as unknown as Model<Chat>,
    messages as unknown as Model<Message>,
    new MemoryModel('Project', ProjectSchema) as unknown as Model<Project>,
    gateway,
    models,
  );
  const actor: Actor = { userId: 'u1', workspaceId: new Types.ObjectId(), plan: 'free' };
  return { svc, actor, credits, messages, chats, usage, lm };
}

async function drain(it: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}
const names = (events: StreamEvent[]) => [...new Set(events.map((e) => e.event))];
const never = () => new AbortController().signal;

describe('ChatsService', () => {
  it('sends a message, streams the answer and saves both, with the model and credits', async () => {
    const { svc, actor, credits } = setup();
    const chat = await svc.create(actor, {});
    expect(chat).toMatchObject({ title: 'New chat', model: 'auto', messageCount: 0 });

    const run = await svc.prepareSend(actor, chat.id, {
      text: 'Write a tagline for a bakery',
      model: 'claude-sonnet',
    });
    const events = await drain(svc.stream(run, never()));
    expect(names(events)).toEqual(['ready', 'model', 'delta', 'done']);
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    if (done.event !== 'done') return;
    expect(done.data.message).toMatchObject({
      role: 'assistant',
      status: 'complete',
      model: 'claude-sonnet',
      modelName: 'Claude Sonnet',
      auto: false,
      credits: 2,
      error: null,
    });
    expect(done.data.message.content).toContain('Write a tagline for a bakery');
    expect(done.data.chat).toMatchObject({
      title: 'Write a tagline for a bakery',
      messageCount: 2,
      model: 'claude-sonnet',
    });
    expect(credits.balances.get(String(actor.workspaceId))).toBe(98);

    const detail = await svc.get(actor, chat.id);
    expect(detail.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
  });

  it('caps the answer length, so the provider never reserves the model maximum', async () => {
    const { svc, actor, lm } = setup();
    const caps: Array<number | undefined> = [];
    lm.mockImplementation((m) => {
      const demo = new DemoLanguageModel(m.key, m.name, 0);
      const doStream = demo.doStream.bind(demo);
      demo.doStream = (o) => {
        caps.push(o.maxOutputTokens);
        return doStream(o);
      };
      return demo;
    });
    const chat = await svc.create(actor, {});
    await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Hello' }), never()));
    expect(caps).toEqual([MAX_ANSWER_TOKENS]);
  });

  it('sends earlier messages as context', async () => {
    const { svc, actor, lm } = setup();
    const chat = await svc.create(actor, {});
    await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'First question' }), never()));
    const spy = new MockLanguageModelV4({
      doStream: {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      },
    });
    lm.mockImplementation(() => spy);
    await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Follow-up' }), never()));
    const prompt = spy.doStreamCalls[0]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('Auto shows which model answered', async () => {
    const { svc, actor } = setup();
    const chat = await svc.create(actor, {});
    const events = await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Hi' }), never()));
    expect(events.find((e) => e.event === 'model')!.data).toMatchObject({
      model: 'claude-haiku',
      auto: true,
    });
  });

  it('saves a "not enough credits" answer instead of failing the request', async () => {
    const { svc, actor } = setup(1);
    const chat = await svc.create(actor, {});
    const events = await drain(
      svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Hello', model: 'claude-sonnet' }), never()),
    );
    const end = events.at(-1)!;
    expect(end.event).toBe('error');
    if (end.event !== 'error') return;
    expect(end.data.message).toMatchObject({
      status: 'failed',
      credits: 0,
      error: { code: 'insufficient_credits' },
    });
  });

  it('refuses a Pro model on Free before saving anything', async () => {
    const { svc, actor, messages } = setup();
    const chat = await svc.create(actor, {});
    await expect(svc.prepareSend(actor, chat.id, { text: 'Hi', model: 'claude-opus' })).rejects.toMatchObject(
      {
        code: 'upgrade_required',
      },
    );
    expect(messages.docs).toHaveLength(0);
  });

  it('Stop keeps what was written, charges once text arrived, and Continue appends', async () => {
    const { svc, actor, credits } = setup();
    const chat = await svc.create(actor, {});
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    for await (const e of svc.stream(
      await svc.prepareSend(actor, chat.id, { text: 'Tell me a story', model: 'claude-sonnet' }),
      ac.signal,
    )) {
      events.push(e);
      if (e.event === 'delta' && events.filter((x) => x.event === 'delta').length === 3) ac.abort();
    }
    const end = events.at(-1)!;
    if (end.event !== 'done') throw new Error(`expected done, got ${end.event}`);
    expect(end.data.message.status).toBe('stopped');
    expect(end.data.message.content.length).toBeGreaterThan(0);
    expect(end.data.message.credits).toBe(2);
    expect(credits.balances.get(String(actor.workspaceId))).toBe(98);

    const cont = await svc.prepareContinue(actor, chat.id, end.data.message.id, {});
    const after = await drain(svc.stream(cont, never()));
    const fin = after.at(-1)!;
    if (fin.event !== 'done') throw new Error('expected done');
    expect(fin.data.message.status).toBe('complete');
    expect(fin.data.message.content.startsWith(end.data.message.content.trimEnd())).toBe(true);
    expect(fin.data.message.credits).toBe(4);
    expect(after.find((e) => e.event === 'ready')!.data).not.toHaveProperty('userMessage.id');
  });

  it('Stop is its own call: it stops a running answer, or marks one left behind as stopped', async () => {
    const { svc, actor, messages } = setup();
    const chat = await svc.create(actor, {});
    expect(await svc.stop(actor, chat.id)).toEqual({ stopped: false });

    const key = runKey.chat(chat.id);
    const run = liveRuns.start(key);
    const events: StreamEvent[] = [];
    for await (const e of svc.stream(
      await svc.prepareSend(actor, chat.id, { text: 'Tell me a story', model: 'claude-sonnet' }),
      run.signal,
    )) {
      events.push(e);
      if (e.event === 'delta' && events.filter((x) => x.event === 'delta').length === 2)
        expect(await svc.stop(actor, chat.id)).toEqual({ stopped: true });
    }
    liveRuns.end(key, run);
    const end = events.at(-1)!;
    if (end.event !== 'done') throw new Error(`expected done, got ${end.event}`);
    expect(end.data.message.status).toBe('stopped');

    // An answer whose run isn't in this process (restart, another server) is marked stopped.
    const orphan = await svc.prepareSend(actor, chat.id, { text: 'Again', model: 'claude-sonnet' });
    expect(await svc.stop(actor, chat.id)).toEqual({ stopped: true });
    expect((await messages.findById(orphan.answer._id).lean<{ status: string }>())!.status).toBe('stopped');
    await expect(svc.stop({ ...actor, workspaceId: new Types.ObjectId() }, chat.id)).rejects.toThrow();
  });

  it('Regenerate rewrites the latest answer and keeps the old version', async () => {
    const { svc, actor, messages } = setup();
    const chat = await svc.create(actor, {});
    const first = await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Hi' }), never()));
    const answerId = (first.at(-1)!.data as { message: { id: string } }).message.id;
    const again = await drain(
      svc.stream(await svc.prepareRegenerate(actor, chat.id, answerId, { model: 'gpt-mini' }), never()),
    );
    expect(again.at(-1)!.data).toMatchObject({
      message: { id: answerId, model: 'gpt-mini', status: 'complete' },
    });
    expect(messages.docs.find((d) => String(d._id) === answerId)!.previousVersions).toHaveLength(1);
    expect((await svc.get(actor, chat.id)).messages).toHaveLength(2);
  });

  it('only rewrites the latest answer and only one answer at a time', async () => {
    const { svc, actor } = setup();
    const chat = await svc.create(actor, {});
    const first = await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'One' }), never()));
    const oldId = (first.at(-1)!.data as { message: { id: string } }).message.id;
    await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Two' }), never()));
    await expect(svc.prepareRegenerate(actor, chat.id, oldId, {})).rejects.toMatchObject({
      code: 'conflict',
    });

    await svc.prepareSend(actor, chat.id, { text: 'Three' }); // left streaming
    await expect(svc.prepareSend(actor, chat.id, { text: 'Four' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('lists pinned chats first, searches titles, renames, deletes, and keeps workspaces apart', async () => {
    const { svc, actor } = setup();
    const a = await svc.create(actor, {});
    await drain(svc.stream(await svc.prepareSend(actor, a.id, { text: 'Bakery tagline' }), never()));
    const b = await svc.create(actor, {});
    await drain(svc.stream(await svc.prepareSend(actor, b.id, { text: 'Pricing page' }), never()));
    await svc.update(actor, a.id, { pinned: true });
    expect((await svc.list(actor, {})).items.map((c) => [c.title, c.pinned])).toEqual([
      ['Bakery tagline', true],
      ['Pricing page', false],
    ]);
    expect((await svc.list(actor, { q: 'pric' })).items.map((c) => c.title)).toEqual(['Pricing page']);
    await svc.update(actor, b.id, { title: 'Pro plan pricing' });
    await svc.remove(actor, a.id);
    expect((await svc.list(actor, {})).items.map((c) => c.title)).toEqual(['Pro plan pricing']);
    await expect(svc.get(actor, a.id)).rejects.toMatchObject({ code: 'not_found' });

    const stranger: Actor = { ...actor, workspaceId: new Types.ObjectId() };
    await expect(svc.get(stranger, b.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.get(actor, 'not-an-id')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('pages through chats with a cursor', async () => {
    const { svc, actor } = setup();
    for (let i = 0; i < 5; i++) {
      const c = await svc.create(actor, {});
      await drain(svc.stream(await svc.prepareSend(actor, c.id, { text: `Chat ${i}` }), never()));
    }
    const p1 = await svc.list(actor, { limit: 2 });
    expect(p1.items.map((c) => c.title)).toEqual(['Chat 4', 'Chat 3']);
    const p2 = await svc.list(actor, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((c) => c.title)).toEqual(['Chat 2', 'Chat 1']);
    const p3 = await svc.list(actor, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((c) => c.title)).toEqual(['Chat 0']);
    expect(p3.nextCursor).toBeNull();
  });

  it('stores feedback on answers', async () => {
    const { svc, actor } = setup();
    const chat = await svc.create(actor, {});
    const ev = await drain(svc.stream(await svc.prepareSend(actor, chat.id, { text: 'Hi' }), never()));
    const id = (ev.at(-1)!.data as { message: { id: string } }).message.id;
    await svc.feedback(actor, chat.id, id, 'up');
    expect((await svc.get(actor, chat.id)).messages[1]!.feedback).toBe('up');
  });
});
