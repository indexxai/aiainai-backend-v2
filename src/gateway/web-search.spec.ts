import { Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreditsService } from '../credits/credits.service.js';
import type { UsageEvent } from '../database/schemas/usage-event.schema.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { GatewayService, SEARCH_CREDITS } from './gateway.service.js';

Logger.overrideLogger(false);

function setup(rows = seedRows()) {
  const models = modelsService(rows, { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' });
  const holds: number[] = [];
  const credits = {
    hold: vi.fn(async (i: { amount: number }) => (holds.push(i.amount), { holdId: 'h1', allocation: [] })),
    settle: vi.fn(async (i: { actual: number }) => ({ charged: i.actual, released: 0, shortfall: 0 })),
    release: vi.fn(async () => ({ charged: 0, released: 0, shortfall: 0 })),
  };
  const usage = { create: vi.fn(async () => undefined) } as unknown as Model<UsageEvent>;
  const gw = new GatewayService(models, credits as unknown as CreditsService, usage);
  return { gw, holds };
}

const ask = {
  workspaceId: '64b000000000000000000001',
  userId: 'u1',
  plan: 'free' as const,
  tool: 'browser',
  model: 'auto',
  key: 'search-1',
  query: 'best high tea buffet in Lahore',
};

describe('web search (OpenRouter web plugin)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('searches through an OpenRouter model and returns the pages it cites', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            id: 'gen-1',
            model: 'anthropic/claude-haiku',
            created: 1,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'Nishat Hotel and Monal Lahore.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url_citation: {
                        url: 'https://nishat.example/high-tea',
                        title: 'Nishat Hotel high tea',
                        content: 'Unlimited buffet from Rs. 1,200',
                        start_index: 0,
                        end_index: 12,
                      },
                    },
                    {
                      type: 'url_citation',
                      url_citation: { url: 'https://nishat.example/high-tea', title: 'Again' },
                    },
                    {
                      type: 'url_citation',
                      url_citation: { url: 'https://monal.example', title: 'Monal Lahore' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { gw, holds } = setup(
      seedRows({
        'claude-haiku': { status: 'live', openrouterModelId: 'anthropic/claude-haiku' },
        // A direct-only model can't use the web plugin, so Auto must not pick it.
        'gpt-mini': { status: 'live', providerModelId: 'gpt-x' },
      }),
    );
    expect(await gw.canWebSearch()).toBe(true);
    const results = await gw.webSearch(ask);
    expect(bodies[0]).toMatchObject({
      model: 'anthropic/claude-haiku',
      plugins: [{ id: 'web', max_results: 6 }],
    });
    expect(results).toEqual([
      {
        title: 'Nishat Hotel high tea',
        url: 'https://nishat.example/high-tea',
        snippet: 'Unlimited buffet from Rs. 1,200',
      },
      { title: 'Monal Lahore', url: 'https://monal.example', snippet: '' },
    ]);
    expect(holds).toEqual([1 + SEARCH_CREDITS]);
  });

  it('is not available without a model routed through OpenRouter', async () => {
    const { gw } = setup(seedRows({ 'gpt-mini': { status: 'live', providerModelId: 'gpt-x' } }));
    expect(await gw.canWebSearch()).toBe(false);
  });
});
