import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { Types, type Connection, type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import type { CreditsService } from '../credits/credits.service.js';
import { ImageGenerationSchema, type ImageGeneration } from '../database/schemas/image.schema.js';
import { UsageEventSchema, type UsageEvent } from '../database/schemas/usage-event.schema.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { StorageService } from '../storage/storage.service.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { MemoryModel } from '../testing/memory-model.js';
import { ImagesService, type Actor } from './images.service.js';
import { imagePrompt, imageTitle } from './images.logic.js';

Logger.overrideLogger(false);

function setup(balance = 100, delayMs = 0) {
  const models = modelsService(seedRows(), { AI_DEMO: true });
  models.providers.demoImageDelayMs = delayMs;
  const credits = new FakeCredits(balance);
  const usage = new MemoryModel('UsageEvent', UsageEventSchema);
  const gateway = new GatewayService(
    models,
    credits as unknown as CreditsService,
    usage as unknown as Model<UsageEvent>,
  );
  const gens = new MemoryModel('ImageGeneration', ImageGenerationSchema);
  const storage = new StorageService(
    { get: () => 'memory' } as unknown as ConfigService<Env, true>,
    {} as Connection,
  );
  const svc = new ImagesService(
    gens as unknown as Model<ImageGeneration>,
    gateway,
    models,
    credits as unknown as CreditsService,
    storage,
  );
  const actor: Actor = { userId: 'u1', workspaceId: new Types.ObjectId(), plan: 'free' };
  const balanceOf = () => credits.balances.get(String(actor.workspaceId));
  const settled = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const g = await svc.get(actor, id);
      if (g.status !== 'generating') return g;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('still generating');
  };
  return { svc, actor, balanceOf, settled, gens, usage };
}

describe('images logic', () => {
  it('builds the model prompt and a gallery title', () => {
    expect(imagePrompt('A desk by a window. ', 'photo', 'people, text')).toBe(
      'A desk by a window. Style: a realistic photograph, natural light, sharp focus. Do not include: people, text.',
    );
    expect(imagePrompt('A logo', 'none', '')).toBe('A logo.');
    expect(imageTitle('a calm desk by a window at sunrise with a laptop')).toBe(
      'A calm desk by a window at…',
    );
  });
});

describe('ImagesService', () => {
  it('generates a batch in the background, stores images and previews, and charges per image', async () => {
    const { svc, actor, balanceOf, settled, usage } = setup();
    const started = await svc.create(actor, {
      prompt: 'A calm desk by a window',
      ratio: '16:9',
      count: 2,
      style: 'photo',
    });
    expect(started.status).toBe('generating');
    expect(started.images.map((i) => i.status)).toEqual(['waiting', 'waiting']);
    expect(balanceOf()).toBe(94); // Imagen (Auto for photos, Free plan): 3 × 2 held

    const done = await settled(started.id);
    expect(done).toMatchObject({
      status: 'done',
      model: 'imagen',
      modelName: 'Imagen',
      auto: true,
      credits: 6,
    });
    expect(done.images[0]).toMatchObject({ status: 'done', width: 1024, height: 576 });
    expect(done.images[0]!.url).toBe(`/api/images/${started.id}/files/0`);
    expect(balanceOf()).toBe(94);
    expect(usage.docs[0]).toMatchObject({ tool: 'image', images: 2, credits: 6, outcome: 'ok' });

    const full = await svc.file(actor, started.id, 1, {});
    expect(full.contentType).toBe('image/png');
    const thumb = await svc.file(actor, started.id, 1, { variant: 'thumb' });
    expect((await sharp(thumb.bytes).metadata()).width).toBe(512);
    const jpg = await svc.file(actor, started.id, 0, { format: 'jpg' });
    expect(jpg).toMatchObject({ contentType: 'image/jpeg', filename: 'a-calm-desk-by-a-window-1.jpg' });
  });

  it('reports not enough credits straight away and keeps nothing', async () => {
    const { svc, actor, gens } = setup(5);
    await expect(svc.create(actor, { prompt: 'Four posters', ratio: '1:1', count: 4 })).rejects.toMatchObject(
      {
        code: 'insufficient_credits',
      },
    );
    expect(gens.docs).toHaveLength(0);
  });

  it('refuses a Pro model on Free before starting', async () => {
    const { svc, actor } = setup();
    await expect(
      svc.create(actor, { prompt: 'A poster', model: 'gpt-image', ratio: '1:1', count: 1 }),
    ).rejects.toMatchObject({
      code: 'upgrade_required',
    });
  });

  it('Cancel keeps finished images and charges only for them', async () => {
    const { svc, actor, balanceOf, settled } = setup(100, 60);
    const g = await svc.create(actor, {
      prompt: 'Product photo of a coffee bag',
      model: 'flux',
      ratio: '1:1',
      count: 4,
    });
    await new Promise((r) => setTimeout(r, 90)); // first two (running in parallel) finish
    await svc.cancel(actor, g.id);
    const done = await settled(g.id);
    expect(done.status).toBe('partial');
    const ok = done.images.filter((i) => i.status === 'done').length;
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(4);
    expect(done.images.filter((i) => i.status === 'cancelled').length).toBe(4 - ok);
    expect(done.credits).toBe(2 * ok);
    expect(balanceOf()).toBe(100 - 2 * ok);
  });

  it('blocked prompts are not charged and say why', async () => {
    const { svc, actor, balanceOf, settled } = setup();
    const g = await svc.create(actor, { prompt: 'BLOCK_DEMO a famous person', ratio: '1:1', count: 2 });
    const done = await settled(g.id);
    expect(done).toMatchObject({ status: 'blocked', credits: 0, error: { code: 'blocked' } });
    expect(balanceOf()).toBe(100);
  });

  it('closes batches interrupted by a restart and returns their credits', async () => {
    const { svc, actor, balanceOf, gens } = setup();
    // A batch left "generating" with credits held, as if the server stopped mid-way.
    const credits = (svc as unknown as { credits: FakeCredits }).credits;
    const { holdId } = await credits.hold({ workspaceId: actor.workspaceId, amount: 6 });
    await gens.create({
      workspaceId: actor.workspaceId,
      createdBy: 'u1',
      prompt: 'x',
      requestedModel: 'auto',
      ratio: '1:1',
      count: 2,
      status: 'generating',
      holdId,
      images: [{ status: 'waiting' }, { status: 'waiting' }],
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    gens.docs[0]!.updatedAt = new Date(Date.now() - 10 * 60_000);
    expect(balanceOf()).toBe(94);
    expect(await svc.sweep()).toBe(1);
    expect(balanceOf()).toBe(100);
    expect(gens.docs[0]).toMatchObject({ status: 'failed' });
  });

  it('lists newest first, searches prompts, deletes, and keeps workspaces apart', async () => {
    const { svc, actor, settled } = setup();
    const a = await svc.create(actor, { prompt: 'A summer sale poster', ratio: '4:3', count: 1 });
    await settled(a.id);
    const b = await svc.create(actor, { prompt: 'A team photo', ratio: '3:2', count: 1 });
    await settled(b.id);
    expect((await svc.list(actor, {})).items.map((g) => g.title)).toEqual([
      'A team photo',
      'A summer sale poster',
    ]);
    expect((await svc.list(actor, { q: 'poster' })).items).toHaveLength(1);
    await svc.remove(actor, a.id);
    expect((await svc.list(actor, {})).items).toHaveLength(1);
    await expect(svc.get({ ...actor, workspaceId: new Types.ObjectId() }, b.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(svc.file(actor, a.id, 0, {})).rejects.toMatchObject({ code: 'not_found' });
  });
});
