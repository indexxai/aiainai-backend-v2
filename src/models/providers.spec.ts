import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './providers.js';
import type { ModelInfo } from './models.logic.js';

const model = (over: Partial<ModelInfo>): ModelInfo =>
  ({
    key: 'x',
    kind: 'image',
    name: 'X',
    provider: 'Google',
    providerModelId: '',
    openrouterModelId: '',
    description: '',
    tags: [],
    credits: 2,
    plans: ['free', 'pro'],
    autoEligible: true,
    status: 'live',
    sortOrder: 1,
    inputPriceMicros: 0,
    outputPriceMicros: 0,
    ...over,
  }) as ModelInfo;

describe('image models', () => {
  it('makes images through OpenRouter when the model has an OpenRouter id', () => {
    const p = new ProviderRegistry({ openrouter: 'or-key', openai: 'oa-key' }, false);
    const gemini = model({ key: 'imagen', openrouterModelId: 'google/gemini-2.5-flash-image' });
    const im = p.imageModel(gemini);
    expect(im).toMatchObject({ provider: 'openrouter', modelId: 'google/gemini-2.5-flash-image' });
    expect(p.imageCall(gemini, '16:9', false)).toEqual({ aspectRatio: '16:9', providerOptions: undefined });
    expect(p.imageCall(gemini, '1:1', true).providerOptions).toEqual({ openrouter: { resolution: '2K' } });
    // No masks through OpenRouter: edits and variations stay with OpenAI's own key.
    expect(p.takesImageInput(gemini)).toBe(false);
  });

  it('uses the OpenAI key for GPT Image set up with an OpenAI model id', () => {
    const p = new ProviderRegistry({ openrouter: 'or-key', openai: 'oa-key' }, false);
    const gpt = model({ key: 'gpt-image', provider: 'OpenAI', providerModelId: 'gpt-image-1' });
    expect(p.imageModel(gpt)).toMatchObject({ provider: expect.stringMatching(/^openai/) });
    expect(p.imageCall(gpt, '9:16', false).size).toBe('1024x1536');
    expect(p.takesImageInput(gpt)).toBe(true);
  });

  it('refuses a model with no route instead of guessing', () => {
    const p = new ProviderRegistry({ openai: 'oa-key' }, false);
    expect(() => p.imageModel(model({ key: 'flux', provider: 'Black Forest Labs' }))).toThrow(/No provider/);
  });
});
