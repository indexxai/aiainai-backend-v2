import { HttpStatus, Logger } from '@nestjs/common';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../common/api-error.js';
import type { CreditsService } from '../credits/credits.service.js';
import type { UsageEvent } from '../database/schemas/usage-event.schema.js';
import { DemoLanguageModel } from '../models/demo-model.js';
import { MODEL_SEED } from '../models/registry.seed.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { GatewayService, type GatewayEvent, type GatewayRequest } from './gateway.service.js';

/** In-memory stand-in for the credits ledger: enough to check hold → settle/release. */
function fakeCredits(balance: number) {
  const calls: Array<{ op: string; amount?: number; actual?: number }> = [];
  const svc = {
    balance: () => balance,
    hold: vi.fn(async (i: { amount: number; key?: string }) => {
      if (i.amount > balance)
        throw new AppError('insufficient_credits', 'Not enough', HttpStatus.PAYMENT_REQUIRED);
      balance -= i.amount;
      calls.push({ op: 'hold', amount: i.amount });
      return { holdId: 'h1', allocation: [] };
    }),
    settle: vi.fn(async (i: { actual: number }) => {
      calls.push({ op: 'settle', actual: i.actual });
      return { charged: i.actual, released: 0, shortfall: 0 };
    }),
    release: vi.fn(async () => {
      calls.push({ op: 'release' });
      return { charged: 0, released: 0, shortfall: 0 };
    }),
  };
  return { svc, calls };
}

function setup(opts: { balance?: number; lm?: (m: { key: string; name: string }) => unknown } = {}) {
  const models = modelsService(seedRows(), { AI_DEMO: true });
  if (opts.lm) vi.spyOn(models.providers, 'languageModel').mockImplementation(opts.lm as never);
  else
    vi.spyOn(models.providers, 'languageModel').mockImplementation(
      (m) => new DemoLanguageModel(m.key, m.name, 0),
    );
  const credits = fakeCredits(opts.balance ?? 100);
  const usage: Array<Partial<UsageEvent>> = [];
  const usageModel = {
    create: vi.fn(async (u: Partial<UsageEvent>) => usage.push(u)),
  } as unknown as Model<UsageEvent>;
  const gw = new GatewayService(models, credits.svc as unknown as CreditsService, usageModel);
  return { gw, credits, usage };
}

const req = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
  workspaceId: '64b000000000000000000001',
  userId: 'u1',
  plan: 'free',
  tool: 'chat',
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: 'Write a tagline for a bakery' }],
  key: 'msg-1',
  ...over,
});

async function collect(it: AsyncIterable<GatewayEvent>) {
  const events: GatewayEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}

const text = (events: GatewayEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

Logger.overrideLogger(false);

describe('GatewayService', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('holds credits, streams the answer, charges the model price and logs usage', async () => {
    const { gw, credits, usage } = setup();
    const events = await collect(gw.stream(req()));
    expect(events[0]).toMatchObject({
      type: 'start',
      model: { key: 'claude-sonnet' },
      auto: false,
      credits: 2,
    });
    expect(text(events)).toContain('Write a tagline for a bakery');
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'ok', credits: 2 });
    expect(credits.calls).toEqual([
      { op: 'hold', amount: 2 },
      { op: 'settle', actual: 2 },
    ]);
    expect(credits.svc.hold.mock.calls[0]![0]).toMatchObject({ key: 'ai:msg-1' });
    expect(usage[0]).toMatchObject({ modelKey: 'claude-sonnet', outcome: 'ok', credits: 2, tool: 'chat' });
    expect(usage[0]!.outputTokens).toBeGreaterThan(0);
  });

  it('Auto picks a model and reports which one answered', async () => {
    const { gw, usage } = setup();
    const events = await collect(
      gw.stream(req({ model: 'auto', messages: [{ role: 'user', content: 'Hi' }] })),
    );
    expect(events[0]).toMatchObject({
      type: 'start',
      auto: true,
      model: { key: 'claude-haiku' },
      credits: 1,
    });
    expect(usage[0]).toMatchObject({ requestedModelKey: 'auto', modelKey: 'claude-haiku' });
  });

  it('refuses before calling the model when credits are short', async () => {
    const lm = vi.fn();
    const { gw, usage } = setup({ balance: 1, lm });
    await expect(collect(gw.stream(req()))).rejects.toMatchObject({ code: 'insufficient_credits' });
    expect(lm).not.toHaveBeenCalled();
    expect(usage).toHaveLength(0);
  });

  it('refuses a Pro model on Free without holding credits', async () => {
    const { gw, credits } = setup();
    await expect(collect(gw.stream(req({ model: 'claude-opus' })))).rejects.toMatchObject({
      code: 'upgrade_required',
    });
    expect(credits.calls).toEqual([]);
  });

  it('returns the credits and shows a plain error when the provider fails', async () => {
    const failing = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('upstream 500 with internal details');
      },
    });
    const { gw, credits, usage } = setup({ lm: () => failing });
    const err = await collect(gw.stream(req())).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'service_unavailable' });
    expect((err as Error).message).not.toContain('internal details');
    expect(credits.calls).toEqual([{ op: 'hold', amount: 2 }, { op: 'release' }]);
    expect(usage[0]).toMatchObject({ outcome: 'failed', credits: 0 });
  });

  it('returns the credits when the provider errors mid-stream', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'Half an ans' },
      { type: 'error', error: new Error('overloaded') },
    ];
    const lm = new MockLanguageModelV4({ doStream: { stream: convertArrayToReadableStream(parts) } });
    const { gw, credits } = setup({ lm: () => lm });
    await expect(collect(gw.stream(req()))).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(credits.calls.at(-1)).toEqual({ op: 'release' });
  });

  describe('Auto fallback', () => {
    // Long enough for Auto's "balanced" list, which starts with Claude Sonnet (2 credits).
    const long = [{ role: 'user' as const, content: 'Plan a launch. '.repeat(30) }];
    const failingFor = (keys: string[], opts: { midStream?: boolean } = {}) => {
      const tried: string[] = [];
      const lm = (m: { key: string; name: string }) => {
        tried.push(m.key);
        if (!keys.includes(m.key)) return new DemoLanguageModel(m.key, m.name, 0);
        if (opts.midStream)
          return new MockLanguageModelV4({
            doStream: {
              stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
                { type: 'text-start', id: '1' },
                { type: 'text-delta', id: '1', delta: 'Half an ans' },
                { type: 'error', error: new Error('overloaded') },
              ]),
            },
          });
        const fail = async () => {
          throw new Error('402: not enough provider credit');
        };
        return new MockLanguageModelV4({ doStream: fail, doGenerate: fail });
      };
      return { lm, tried };
    };

    it('moves to a cheaper model when the first one fails before any text', async () => {
      const { lm, tried } = failingFor(['claude-sonnet']);
      const { gw, credits, usage } = setup({ lm });
      const events = await collect(gw.stream(req({ model: 'auto', messages: long })));
      expect(tried).toEqual(['claude-sonnet', 'gpt-mini']);
      expect(events.filter((e) => e.type === 'start').map((e) => e.model.key)).toEqual([
        'claude-sonnet',
        'gpt-mini',
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'ok', credits: 1 });
      // The failed attempt's hold is returned; only the model that answered is charged.
      expect(credits.calls).toEqual([
        { op: 'hold', amount: 2 },
        { op: 'release' },
        { op: 'hold', amount: 1 },
        { op: 'settle', actual: 1 },
      ]);
      expect(credits.svc.hold.mock.calls.map((c) => c[0].key)).toEqual(['ai:msg-1', 'ai:msg-1:fallback-2']);
      expect(usage.map((u) => [u.modelKey, u.outcome])).toEqual([
        ['claude-sonnet', 'failed'],
        ['gpt-mini', 'ok'],
      ]);
    });

    it('also falls back for structured answers (outlines, AI edits)', async () => {
      const { lm, tried } = failingFor(['claude-sonnet']);
      const { gw, credits } = setup({ lm });
      const r = await gw.object({
        ...req({ model: 'auto', messages: long }),
        // Outline-shaped, so the stand-in model fills it in.
        schema: z.object({
          title: z.string(),
          sections: z.array(z.object({ heading: z.string(), note: z.string() })),
        }),
      });
      expect(tried).toEqual(['claude-sonnet', 'gpt-mini']);
      expect(r).toMatchObject({ model: { key: 'gpt-mini' }, auto: true, credits: 1 });
      expect(credits.calls.at(-1)).toEqual({ op: 'settle', actual: 1 });
    });

    it('never swaps a model the person picked', async () => {
      const { lm, tried } = failingFor(['claude-sonnet']);
      const { gw, credits } = setup({ lm });
      await expect(collect(gw.stream(req({ messages: long })))).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(tried).toEqual(['claude-sonnet']);
      expect(credits.calls).toEqual([{ op: 'hold', amount: 2 }, { op: 'release' }]);
    });

    it('does not switch models once text has arrived', async () => {
      const { lm, tried } = failingFor(['claude-sonnet'], { midStream: true });
      const { gw } = setup({ lm });
      await expect(collect(gw.stream(req({ model: 'auto', messages: long })))).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(tried).toEqual(['claude-sonnet']);
    });

    it('gives up after a few models and returns every credit', async () => {
      const { lm, tried } = failingFor(MODEL_SEED.map((m) => m.key));
      const { gw, credits } = setup({ lm });
      await expect(collect(gw.stream(req({ model: 'auto', messages: long })))).rejects.toMatchObject({
        code: 'service_unavailable',
      });
      expect(tried).toHaveLength(3);
      expect(credits.calls.filter((c) => c.op === 'settle')).toHaveLength(0);
      expect(credits.calls.filter((c) => c.op === 'release')).toHaveLength(3);
    });
  });

  it('Stop after text has arrived charges the message and records "stopped"', async () => {
    const { gw, credits, usage } = setup();
    const stream = gw.stream(req());
    for await (const e of stream) {
      if (e.type === 'text') break; // the caller stops reading, like the Stop button
    }
    expect(credits.calls).toEqual([
      { op: 'hold', amount: 2 },
      { op: 'settle', actual: 2 },
    ]);
    expect(usage[0]).toMatchObject({ outcome: 'stopped', credits: 2 });
  });

  it('Stop before any text returns the credits', async () => {
    const { gw, credits, usage } = setup();
    const ac = new AbortController();
    ac.abort();
    const events = await collect(gw.stream(req({ abortSignal: ac.signal })));
    expect(text(events)).toBe('');
    expect(events.at(-1)).toMatchObject({ type: 'finish', outcome: 'stopped', credits: 0 });
    expect(credits.calls.at(-1)).toEqual({ op: 'release' });
    expect(usage[0]).toMatchObject({ outcome: 'stopped', credits: 0 });
  });
});
