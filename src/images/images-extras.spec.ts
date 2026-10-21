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
import { ImagesService, providerMask, type Actor } from './images.service.js';

Logger.overrideLogger(false);

function setup(plan: 'free' | 'pro' = 'pro', balance = 100) {
  const models = modelsService(seedRows(), { AI_DEMO: true });
  models.providers.demoImageDelayMs = 0;
  const credits = new FakeCredits(balance);
  const usage = new MemoryModel('UsageEvent', UsageEventSchema);
  const gateway = new GatewayService(
    models,
    credits as unknown as CreditsService,
    usage as unknown as Model<UsageEvent>,
  );
  const storage = new StorageService(
    { get: () => 'memory' } as unknown as ConfigService<Env, true>,
    {} as Connection,
  );
  const gens = new MemoryModel('ImageGeneration', ImageGenerationSchema);
  const svc = new ImagesService(
    gens as unknown as Model<ImageGeneration>,
    gateway,
    models,
    credits as unknown as CreditsService,
    storage,
  );
  const actor: Actor = { userId: 'u1', workspaceId: new Types.ObjectId(), plan };
  const balanceOf = () => credits.balances.get(String(actor.workspaceId))!;
  const settled = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      const g = await svc.get(actor, id);
      if (g.status !== 'generating') return g;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('still generating');
  };
  const first = async () => {
    const g = await svc.create(actor, { prompt: 'A desk by a window at sunrise', ratio: '1:1', count: 1 });
    return settled(g.id);
  };
  return { svc, actor, balanceOf, settled, first, usage };
}

const boxMask = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#000' } })
    .composite([
      {
        input: { create: { width: w / 4, height: h / 4, channels: 3, background: '#fff' } },
        left: w / 2,
        top: h / 2,
      },
    ])
    .png()
    .toBuffer();

describe('image extras', () => {
  it('makes four variations of one image, linked to their source', async () => {
    const { svc, actor, settled, first } = setup();
    const src = await first();
    const v = await settled((await svc.variations(actor, src.id, 0)).id);
    expect(v).toMatchObject({
      kind: 'variations',
      count: 4,
      status: 'done',
      source: { id: src.id, index: 0 },
    });
    expect(v.images.every((i) => i.status === 'done')).toBe(true);
  });

  it('edits the selected area only, and refuses an empty selection', async () => {
    const { svc, actor, settled, first } = setup();
    const src = await first();
    const before = await svc.file(actor, src.id, 0, {});
    const mask = await boxMask(256, 256);
    const e = await settled((await svc.edit(actor, src.id, 0, { prompt: 'a coffee mug', mask })).id);
    expect(e).toMatchObject({ kind: 'edit', status: 'done', prompt: 'a coffee mug' });
    const after = await svc.file(actor, e.id, 0, {});
    // A pixel outside the box is unchanged; one inside is repainted.
    const px = async (b: Buffer, x: number, y: number) => {
      const { data, info } = await sharp(b).raw().toBuffer({ resolveWithObject: true });
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(await px(after.bytes, 20, 20)).toEqual(await px(before.bytes, 20, 20));
    expect(await px(after.bytes, 700, 700)).not.toEqual(await px(before.bytes, 700, 700));
    const empty = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    await expect(svc.edit(actor, src.id, 0, { prompt: 'x', mask: empty })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('upscales and removes backgrounds on Pro at their fixed prices', async () => {
    const { svc, actor, settled, first, balanceOf } = setup('pro');
    const src = await first();
    const before = balanceOf();
    const up = await settled((await svc.tool(actor, src.id, 0, 'upscale')).id);
    expect(up).toMatchObject({ kind: 'upscale', status: 'done', credits: 2, modelName: 'Upscale' });
    expect(up.images[0]!.width).toBe(src.images[0]!.width! * 2);
    const cut = await settled((await svc.tool(actor, src.id, 0, 'cutout')).id);
    expect(cut).toMatchObject({ kind: 'cutout', status: 'done', credits: 1 });
    const meta = await sharp((await svc.file(actor, cut.id, 0, {})).bytes).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(balanceOf()).toBe(before - 3);
  });

  it('keeps Upscale and Remove background for Pro', async () => {
    const { svc, actor, first } = setup('free');
    const src = await first();
    await expect(svc.tool(actor, src.id, 0, 'upscale')).rejects.toMatchObject({ code: 'upgrade_required' });
    // GPT Image (the model that edits) is a Pro model, so Free has no edits either.
    expect(await svc.capabilities(actor)).toMatchObject({
      upscale: true,
      toolsIncluded: false,
      edit: false,
      editModel: null,
    });
  });

  it('uses an uploaded reference image and rejects files that are not images', async () => {
    const { svc, actor, settled } = setup();
    const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3a6' } })
      .jpeg()
      .toBuffer();
    const ref = await svc.uploadReference(actor, photo, 'office-photo.jpg');
    expect(ref).toMatchObject({ name: 'office-photo.jpg', width: 800, height: 600 });
    const g = await settled(
      (
        await svc.create(actor, {
          prompt: 'Same desk at sunrise',
          ratio: '1:1',
          count: 1,
          reference: { id: ref.id, use: 'layout' },
        })
      ).id,
    );
    expect(g).toMatchObject({ status: 'done', reference: { name: 'office-photo.jpg', use: 'layout' } });
    await expect(
      svc.uploadReference(actor, Buffer.from('not an image'), 'site-video.mov'),
    ).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      svc.create(actor, {
        prompt: 'x y z',
        ratio: '1:1',
        count: 1,
        reference: { id: 'a'.repeat(24), use: 'style' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('improves a prompt for free', async () => {
    const { svc, actor, balanceOf, usage } = setup();
    const before = balanceOf();
    const r = await svc.improvePrompt(actor, { prompt: 'desk by window sunrise laptop' });
    expect(r.prompt.length).toBeGreaterThan(10);
    expect(balanceOf()).toBe(before);
    expect(usage.docs.at(-1)).toMatchObject({ credits: 0, outcome: 'ok' });
  });

  it('turns the person’s mask into the provider’s (transparent = change)', async () => {
    const m = await providerMask(await boxMask(100, 100), 200, 200);
    const { data, info } = await sharp(m).raw().toBuffer({ resolveWithObject: true });
    const a = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect(info).toMatchObject({ width: 200, height: 200, channels: 4 });
    expect(a(10, 10)).toBe(255);
    expect(a(120, 120)).toBe(0);
  });
});
