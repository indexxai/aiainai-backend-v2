import { describe, expect, it } from 'vitest';
import { AppError } from '../common/api-error.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { demoEnabled } from './providers.js';

describe('demo mode', () => {
  it('is on locally without keys, off with a key, and never in production', () => {
    expect(demoEnabled({ NODE_ENV: 'development' }, {})).toBe(true);
    expect(demoEnabled({ NODE_ENV: 'development' }, { anthropic: 'k' })).toBe(false);
    expect(demoEnabled({ NODE_ENV: 'development', AI_DEMO: true }, { anthropic: 'k' })).toBe(true);
    expect(demoEnabled({ NODE_ENV: 'production', AI_DEMO: true }, {})).toBe(false);
  });
});

describe('ModelsService.menu', () => {
  it('lists text models with Auto, plan locks and the saved default', async () => {
    const svc = modelsService(seedRows(), { AI_DEMO: true });
    const menu = await svc.menu('text', 'free', 'claude-sonnet');
    expect(menu.demo).toBe(true);
    expect(menu.auto?.key).toBe('auto');
    expect(menu.selected).toBe('claude-sonnet');
    expect(menu.models.map((m) => m.key).slice(0, 4)).toEqual([
      'gpt',
      'gpt-mini',
      'claude-opus',
      'claude-sonnet',
    ]);
    const gpt = menu.models.find((m) => m.key === 'gpt')!;
    expect(gpt).toMatchObject({ locked: true, requiredPlan: 'pro', credits: 3 });
    expect(menu.models.find((m) => m.key === 'gpt-mini')!.locked).toBe(false);
    expect(menu.models.every((m) => !('providerModelId' in m))).toBe(true);
  });

  it('falls back to Auto when the saved default is locked or gone', async () => {
    const svc = modelsService(seedRows(), { AI_DEMO: true });
    expect((await svc.menu('text', 'free', 'claude-opus')).selected).toBe('auto');
    expect((await svc.menu('text', 'pro', 'claude-opus')).selected).toBe('claude-opus');
    expect((await svc.menu('text', 'pro', 'retired-model')).selected).toBe('auto');
  });

  it('shows only configured models when real keys are set', async () => {
    const rows = seedRows({ 'claude-sonnet': { status: 'live', providerModelId: 'sonnet-id' } });
    const svc = modelsService(rows, { ANTHROPIC_API_KEY: 'k' });
    const menu = await svc.menu('text', 'free', 'auto');
    expect(menu.demo).toBe(false);
    expect(menu.models.map((m) => m.key)).toEqual(['claude-sonnet']);
  });

  it('offers Auto for images too, picking by style within the plan', async () => {
    const svc = modelsService(seedRows(), { AI_DEMO: true });
    const menu = await svc.menu('image', 'free', 'auto');
    expect(menu.auto?.description).toContain('image');
    expect(menu.selected).toBe('auto');
    expect((await svc.resolveImage('auto', 'free', { style: 'photo' })).model.key).toBe('imagen');
    expect((await svc.resolveImage('auto', 'free', { style: 'none' })).model.key).toBe('imagen'); // GPT Image is Pro
    expect((await svc.resolveImage('auto', 'pro', { style: 'none' })).model.key).toBe('gpt-image');
    expect((await svc.resolveImage('auto', 'free', { style: 'illustration' })).model.key).toBe('flux');
  });
});

describe('ModelsService.resolve', () => {
  const svc = modelsService(seedRows(), { AI_DEMO: true });

  it('asks for an upgrade for a Pro model on Free', async () => {
    const err = await svc.resolve('claude-opus', 'free', { chars: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'upgrade_required', status: 403, details: { requiredPlan: 'pro' } });
  });

  it('reports a key that is not a model as a bad request', async () => {
    await expect(svc.resolve('nope', 'pro', { chars: 1 })).rejects.toMatchObject({
      code: 'validation_failed',
      status: 422,
    });
  });

  it('resolves Auto to a concrete model', async () => {
    const r = await svc.resolve('auto', 'free', { chars: 10 });
    expect(r).toMatchObject({ auto: true, model: { key: 'claude-haiku' } });
  });
});
