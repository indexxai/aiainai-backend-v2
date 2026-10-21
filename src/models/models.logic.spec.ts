import { describe, expect, it } from 'vitest';
import { seedRows } from '../testing/fake-models.js';
import {
  costMicros,
  isServable,
  pickAuto,
  routeOf,
  providerIdOf,
  requiredPlan,
  type Availability,
} from './models.logic.js';

const live = (keys: string[]) =>
  seedRows(Object.fromEntries(keys.map((k) => [k, { status: 'live' as const, providerModelId: `${k}-id` }])));
const byKey = (rows: ReturnType<typeof seedRows>, k: string) => rows.find((r) => r.key === k)!;
const noDemo = (keys: Availability['keys']): Availability => ({ demo: false, keys });

describe('isServable', () => {
  it('needs live status, a provider model id and the provider key', () => {
    const rows = live(['gpt', 'claude-sonnet']);
    const av = noDemo(new Set(['anthropic']));
    expect(isServable(byKey(rows, 'claude-sonnet'), av)).toBe(true);
    expect(isServable(byKey(rows, 'gpt'), av)).toBe(false); // no OpenAI key
    expect(isServable(byKey(rows, 'claude-haiku'), av)).toBe(false); // hidden, no id
  });

  it('serves every unpaused model in demo mode', () => {
    const rows = seedRows({ kimi: { status: 'paused' } });
    const av = { demo: true, keys: new Set<never>() };
    expect(isServable(byKey(rows, 'claude-opus'), av)).toBe(true);
    expect(isServable(byKey(rows, 'kimi'), av)).toBe(false);
  });

  it('does not serve providers the gateway cannot call yet', () => {
    const rows = live(['gemini-pro']);
    expect(providerIdOf('Google')).toBe('google');
    // Gemini has no direct route; it needs OpenRouter.
    expect(isServable(byKey(rows, 'gemini-pro'), noDemo(new Set(['openai', 'anthropic'])))).toBe(false);
  });

  it('serves any provider through OpenRouter when the model has an OpenRouter id', () => {
    const rows = seedRows({
      'gemini-pro': { status: 'live', openrouterModelId: 'google/gemini-x' },
      gpt: { status: 'live', providerModelId: 'gpt-x', openrouterModelId: 'openai/gpt-x' },
      deepseek: { status: 'live' },
    });
    const av: Availability = { demo: false, keys: new Set(['openai']), openrouter: true };
    expect(isServable(byKey(rows, 'gemini-pro'), av)).toBe(true);
    expect(routeOf(byKey(rows, 'gpt'), av)).toBe('openrouter');
    expect(routeOf(byKey(rows, 'gpt'), { ...av, openrouter: false })).toBe('direct');
    expect(isServable(byKey(rows, 'deepseek'), av)).toBe(false); // no OpenRouter id set
  });
});

describe('pickAuto', () => {
  const text = seedRows().filter((m) => m.kind === 'text');

  it('sends short prompts to a fast model and longer ones to a balanced model', () => {
    expect(pickAuto(text, 'free', { chars: 40 })!.key).toBe('claude-haiku');
    expect(pickAuto(text, 'free', { chars: 2000 })!.key).toBe('claude-sonnet');
    expect(pickAuto(text, 'free', { chars: 40, hasFiles: true })!.key).toBe('claude-sonnet');
  });

  it('never picks a model outside the plan', () => {
    const onlyPro = text.filter((m) => m.key === 'gpt' || m.key === 'gpt-mini');
    expect(pickAuto(onlyPro, 'free', { chars: 2000 })!.key).toBe('gpt-mini');
    expect(pickAuto(onlyPro, 'pro', { chars: 2000 })!.key).toBe('gpt');
  });

  it('after a failure, goes to a cheaper model rather than the next in line', () => {
    // Pro's balanced list is Sonnet (2) → GPT (3) → … ; GPT costs more, so skip it.
    expect(pickAuto(text, 'pro', { chars: 2000 }, ['claude-sonnet'])!.key).toBe('gpt-mini');
    expect(pickAuto(text, 'free', { chars: 2000 }, ['claude-sonnet'])!.key).toBe('gpt-mini');
    // Nothing cheaper than 1 credit is preferred: the cheapest one left.
    expect(pickAuto(text, 'free', { chars: 2000 }, ['claude-sonnet', 'gpt-mini'])!.key).toBe('claude-haiku');
    expect(pickAuto(text, 'free', { chars: 40 }, ['claude-haiku'])!.credits).toBe(1);
  });

  it('falls back to the cheapest eligible model, or null when none', () => {
    const others = text.filter((m) => ['kimi', 'deepseek'].includes(m.key));
    expect(['kimi', 'deepseek']).toContain(pickAuto(others, 'free', { chars: 10 })!.key);
    expect(pickAuto([], 'pro', { chars: 10 })).toBeNull();
    const notEligible = text.map((m) => ({ ...m, autoEligible: false }));
    expect(pickAuto(notEligible, 'pro', { chars: 10 })).toBeNull();
  });
});

describe('pricing', () => {
  it('computes provider cost in micro-dollars from per-million prices', () => {
    const m = { ...seedRows()[0]!, inputPriceMicros: 3_000_000, outputPriceMicros: 15_000_000 };
    expect(costMicros(m, { inputTokens: 1000, outputTokens: 500 })).toBe(3000 + 7500);
  });

  it('labels the cheapest plan that includes a model', () => {
    expect(requiredPlan({ plans: ['pro'] })).toBe('pro');
    expect(requiredPlan({ plans: ['free', 'pro'] })).toBe('free');
  });
});
