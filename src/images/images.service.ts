import { HttpStatus, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../common/api-error.js';
import { CreditsService } from '../credits/credits.service.js';
import { IMAGE_KINDS, ImageGeneration, type REFERENCE_USES } from '../database/schemas/image.schema.js';
import type { Plan } from '../database/schemas/workspace.schema.js';
import { scoped } from '../database/scoped.js';
import { GatewayService, type ImageResult } from '../gateway/gateway.service.js';
import { AUTO } from '../models/models.logic.js';
import { ModelsService } from '../models/models.service.js';
import type { ImageRatio } from '../models/providers.js';
import { StorageService } from '../storage/storage.service.js';
import type { ImageCapabilitiesDto, ImageGenerationDto, ImageListDto, ReferenceDto } from './images.dto.js';
import {
  CUTOUT_CREDITS,
  editPrompt,
  imagePrompt,
  imageTitle,
  improveMessages,
  referencePrompt,
  TOOL_PLAN,
  UPSCALE_CREDITS,
  VARIATION_COUNT,
  variationPrompt,
  type ImageStyle,
} from './images.logic.js';

export interface Actor {
  userId: string;
  workspaceId: Types.ObjectId;
  plan: Plan;
  /** Model makers switched off for this space (Business). */
  space?: 'personal' | 'business';
}

type GenLean = ImageGeneration & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

export interface CreateImages {
  prompt: string;
  model?: string;
  ratio: ImageRatio;
  count: number;
  hd?: boolean;
  style?: ImageStyle;
  negative?: string;
  /** An uploaded reference image (POST /api/images/references) and what it should guide. */
  reference?: { id: string; use: ReferenceUse };
  /** Jack (in a conversation) or an AI Crews agent asked for these; unset: the person. */
  madeBy?: 'jack' | 'team';
}

type Kind = (typeof IMAGE_KINDS)[number];
type ReferenceUse = (typeof REFERENCE_USES)[number];

const improveSchema = z.object({ prompt: z.string() });
/** Reference uploads: JPG, PNG or WebP up to 20 MB; stored as PNG, at most 2048 px on the long side. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const REFERENCE_PX = 2048;

const PAGE = 20;
/** A batch still "generating" after this long was interrupted (e.g. a restart). */
const STALE_MS = 5 * 60 * 1000;
const THUMB_PX = 512;

const notFound = () => new AppError('not_found', 'We can’t find those images.', HttpStatus.NOT_FOUND);
const oid = (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  return new Types.ObjectId(id);
};

/**
 * AI Image: a prompt and settings become a batch of 1–4 images, generated in the background
 * (the page polls for progress). Each finished image is stored with a small preview and charged;
 * failed or cancelled ones are not.
 */
@Injectable()
export class ImagesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImagesService.name);
  private readonly running = new Map<string, AbortController>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    @InjectModel(ImageGeneration.name) private readonly gens: Model<ImageGeneration>,
    private readonly gateway: GatewayService,
    private readonly models: ModelsService,
    private readonly credits: CreditsService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), 60_000);
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    for (const ac of this.running.values()) ac.abort();
  }

  /**
   * Starts a batch. Returns once credits are reserved, so "not enough credits" and plan errors
   * come back straight away; the images then arrive in the background.
   */
  async create(actor: Actor, input: CreateImages): Promise<ImageGenerationDto> {
    const style = input.style ?? 'none';
    const model = input.model ?? AUTO;
    const ref = input.reference ? await this.loadReference(actor, input.reference.id) : null;
    // Plan / availability errors now, before anything is saved.
    await this.models.resolveImage(model, actor.plan, {
      style,
      needsImageInput: !!ref,
    });
    return this.startBatch(
      actor,
      {
        kind: 'generate',
        prompt: input.prompt.trim(),
        negative: (input.negative ?? '').trim(),
        requestedModel: model,
        ratio: input.ratio,
        count: input.count,
        hd: !!input.hd,
        style,
        reference: ref && input.reference ? { key: ref.key, name: ref.name, use: input.reference.use } : null,
        madeBy: input.madeBy,
      },
      {
        prompt: ref
          ? referencePrompt(input.prompt, input.reference!.use, style, input.negative ?? '')
          : imagePrompt(input.prompt, style, input.negative ?? ''),
        images: ref ? [{ bytes: ref.bytes, mediaType: 'image/png' }] : undefined,
      },
    );
  }

  /** Four new takes on one image, close to it in subject and layout. */
  async variations(actor: Actor, id: string, index: number): Promise<ImageGenerationDto> {
    const { gen, bytes } = await this.sourceImage(actor, id, index);
    const model = gen.model ?? gen.requestedModel ?? AUTO;
    return this.startBatch(
      actor,
      {
        kind: 'variations',
        source: { id: gen._id, index },
        prompt: gen.prompt,
        negative: gen.negative ?? '',
        requestedModel: (await this.canUse(model, actor.plan)) ? model : AUTO,
        ratio: gen.ratio as ImageRatio,
        count: VARIATION_COUNT,
        hd: !!gen.hd,
        style: gen.style ?? 'none',
      },
      { prompt: variationPrompt(gen.prompt), images: [{ bytes, mediaType: 'image/png' }] },
    );
  }

  /**
   * Change part of an image: `mask` marks the area (white or opaque = change it), `prompt` says
   * what should be there. The rest stays the same. The result is a new image; the original is kept.
   */
  async edit(
    actor: Actor,
    id: string,
    index: number,
    input: { prompt: string; mask: Buffer; model?: string },
  ): Promise<ImageGenerationDto> {
    const { gen, bytes, width, height } = await this.sourceImage(actor, id, index);
    const mask = await providerMask(input.mask, width, height);
    const model = input.model ?? AUTO;
    return this.startBatch(
      actor,
      {
        kind: 'edit',
        source: { id: gen._id, index },
        prompt: input.prompt.trim(),
        negative: '',
        requestedModel: model,
        ratio: gen.ratio as ImageRatio,
        count: 1,
        hd: !!gen.hd,
        style: gen.style ?? 'none',
      },
      { prompt: editPrompt(input.prompt), images: [{ bytes, mediaType: 'image/png' }], mask },
    );
  }

  /** Upscale or Remove background (Pro): a new image made from one of a batch. */
  async tool(
    actor: Actor,
    id: string,
    index: number,
    tool: 'upscale' | 'cutout',
  ): Promise<ImageGenerationDto> {
    if (actor.plan !== TOOL_PLAN)
      throw new AppError(
        'upgrade_required',
        tool === 'upscale'
          ? 'Upscaling is on the Jack Personal plan.'
          : 'Removing backgrounds is on the Jack Personal plan.',
        HttpStatus.FORBIDDEN,
        { requiredPlan: TOOL_PLAN },
      );
    if (!this.models.imageTools.available[tool])
      throw new AppError(
        'model_unavailable',
        'This tool isn’t available right now.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    const { gen, bytes } = await this.sourceImage(actor, id, index);
    const credits = tool === 'upscale' ? UPSCALE_CREDITS : CUTOUT_CREDITS;
    const doc = await this.gens.create({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      kind: tool,
      source: { id: gen._id, index },
      prompt: gen.prompt,
      title: gen.title || imageTitle(gen.prompt),
      negative: '',
      requestedModel: tool,
      model: tool,
      ratio: gen.ratio,
      count: 1,
      hd: !!gen.hd,
      style: gen.style ?? 'none',
      status: 'generating',
      images: [{ status: 'waiting' as const }],
    });
    const newId = doc._id as Types.ObjectId;
    const ac = new AbortController();
    this.running.set(newId.toHexString(), ac);
    // Credits are held before returning, so "not enough credits" comes back straight away.
    let held = false;
    let started!: () => void;
    let failedToStart!: (e: unknown) => void;
    const ready = new Promise<void>((res, rej) => {
      started = res;
      failedToStart = rej;
    });
    const job = this.gateway.imageTool({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      tool,
      credits,
      input: bytes,
      key: `img:${newId.toHexString()}`,
      ref: { kind: 'image', id: newId.toHexString() },
      abortSignal: ac.signal,
      onStart: async ({ holdId }) => {
        held = true;
        await this.gens.updateOne({ _id: newId }, { $set: { holdId } });
        started();
      },
    });
    job.catch((err: unknown) => {
      if (!held) failedToStart(err);
    });
    void job
      .then(async ({ result, credits: charged }) => {
        await this.saveImage(actor, newId, 0, result);
        await this.gens.updateOne(
          { _id: newId },
          { $set: { status: 'done', credits: charged, error: null }, $unset: { holdId: 1 } },
        );
      })
      .catch(async (err: unknown) => {
        if (!held) return;
        await this.gens.updateOne(
          { _id: newId },
          {
            $set: {
              status: 'failed',
              'images.0': { status: ac.signal.aborted ? 'cancelled' : 'failed' },
              error:
                err instanceof AppError && err.code !== 'service_unavailable'
                  ? { code: err.code, message: err.message }
                  : { code: 'service_unavailable', message: 'That didn’t work. No credits were used.' },
            },
            $unset: { holdId: 1 },
          },
        );
      })
      .finally(() => this.running.delete(newId.toHexString()));
    try {
      await ready;
    } catch (err) {
      await this.gens.deleteOne({ _id: newId });
      throw err;
    }
    return this.get(actor, newId.toHexString());
  }

  /** "Improve prompt": a fuller description to use instead. Free. */
  async improvePrompt(
    actor: Actor,
    input: { prompt: string; style?: ImageStyle },
  ): Promise<{ prompt: string }> {
    const m = improveMessages(input.prompt, input.style ?? 'none');
    const key = new Types.ObjectId().toHexString();
    const r = await this.gateway.object({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      plan: actor.plan,
      tool: 'image',
      model: AUTO,
      system: m.system,
      messages: [{ role: 'user', content: m.prompt }],
      key: `img-improve:${key}`,
      ref: { kind: 'image-prompt', id: key },
      schema: improveSchema,
      price: { credits: 0 },
    });
    return {
      prompt: r.object.prompt
        .trim()
        .replace(/^["“]|["”]$/g, '')
        .slice(0, 1000),
    };
  }

  /** Store an uploaded reference image for this workspace; returns its id for POST /api/images. */
  async uploadReference(actor: Actor, bytes: Buffer, name: string): Promise<ReferenceDto> {
    const bad = () =>
      new AppError(
        'validation_failed',
        `${name || 'That file'} isn’t an image. Use a JPG, PNG or WebP under 20 MB.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw bad();
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(bytes).metadata();
    } catch {
      throw bad();
    }
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw bad();
    const png = await sharp(bytes)
      .rotate()
      .resize({ width: REFERENCE_PX, height: REFERENCE_PX, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const out = await sharp(png).metadata();
    const id = randomBytes(12).toString('hex');
    const clean = name.replace(/[^\w .()-]/g, '').slice(0, 80) || 'reference.png';
    await this.storage.put(this.referenceKey(actor, id), png, 'image/png');
    await this.storage.put(`${this.referenceKey(actor, id)}.name`, Buffer.from(clean), 'text/plain');
    return { id, name: clean, width: out.width ?? 0, height: out.height ?? 0 };
  }

  /** Which extra tools can be used right now (they depend on the plan and on the providers set up). */
  async capabilities(actor: Actor): Promise<ImageCapabilitiesDto> {
    const tools = this.models.imageTools.available;
    const editModel = await this.models
      .resolveImage(AUTO, actor.plan, { needsImageInput: true })
      .then(({ model: m }) => ({ key: m.key, name: m.name, credits: m.credits }))
      .catch(() => null);
    return {
      editModel,
      // Reference, variations and edits need a model on this plan that takes an image as input.
      reference: !!editModel,
      variations: !!editModel,
      edit: !!editModel,
      upscale: tools.upscale,
      removeBackground: tools.cutout,
      toolsPlan: TOOL_PLAN,
      toolsIncluded: actor.plan === TOOL_PLAN,
      upscaleCredits: UPSCALE_CREDITS,
      removeBackgroundCredits: CUTOUT_CREDITS,
      variationCount: VARIATION_COUNT,
    };
  }

  /** Create the record and run the batch in the background; returns once credits are held. */
  private async startBatch(
    actor: Actor,
    fields: {
      kind: Kind;
      source?: { id: Types.ObjectId; index: number };
      prompt: string;
      negative: string;
      requestedModel: string;
      ratio: ImageRatio;
      count: number;
      hd: boolean;
      style: ImageStyle;
      reference?: { key: string; name: string; use: ReferenceUse } | null;
      madeBy?: 'jack' | 'team';
    },
    send: { prompt: string; images?: { bytes: Buffer; mediaType: string }[]; mask?: Buffer },
  ): Promise<ImageGenerationDto> {
    const gen = await this.gens.create({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      ...fields,
      title: imageTitle(fields.prompt),
      status: 'generating',
      images: Array.from({ length: fields.count }, () => ({ status: 'waiting' as const })),
    });
    const id = gen._id as Types.ObjectId;
    const ac = new AbortController();
    this.running.set(id.toHexString(), ac);

    let started!: () => void;
    let failedToStart!: (e: unknown) => void;
    const ready = new Promise<void>((res, rej) => {
      started = res;
      failedToStart = rej;
    });
    let begun = false;

    void this.gateway
      .imageBatch({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        plan: actor.plan,
        model: fields.requestedModel,
        style: fields.style,
        prompt: send.prompt,
        images: send.images,
        mask: send.mask,
        count: fields.count,
        ratio: fields.ratio,
        hd: fields.hd,
        // Different seed per image so a batch gives variety (where the model supports seeds).
        seed: Math.floor(Math.random() * 1_000_000),
        key: `img:${id.toHexString()}`,
        ref: { kind: 'image', id: id.toHexString() },
        abortSignal: ac.signal,
        onStart: async (info) => {
          begun = true;
          await this.gens.updateOne(
            { _id: id },
            { $set: { holdId: info.holdId, model: info.model.key, auto: info.auto } },
          );
          started();
        },
        onImage: (i, r) => this.saveImage(actor, id, i, r),
        cancelled: async () => !!(await this.gens.exists({ _id: id, cancelRequested: true })),
      })
      .then(async (res) => {
        const status = res.blocked
          ? 'blocked'
          : res.ok === fields.count
            ? 'done'
            : res.ok > 0
              ? 'partial'
              : 'failed';
        await this.gens.updateOne(
          { _id: id },
          {
            $set: {
              status,
              credits: res.credits,
              model: res.model.key,
              auto: res.auto,
              error: res.blocked
                ? { code: 'blocked', message: res.blocked }
                : res.ok === 0
                  ? {
                      code: 'service_unavailable',
                      message: 'The images didn’t finish. No credits were used.',
                    }
                  : null,
            },
            $unset: { holdId: 1 },
          },
        );
      })
      .catch(async (err: unknown) => {
        if (!begun) return failedToStart(err);
        this.logger.error({ err, id: id.toHexString() }, 'Image batch failed');
        await this.gens.updateOne({ _id: id }, { $set: { status: 'failed' } });
      })
      .finally(() => this.running.delete(id.toHexString()));

    try {
      await ready;
    } catch (err) {
      // Nothing was reserved: remove the empty batch and report why (e.g. not enough credits).
      await this.gens.deleteOne({ _id: id });
      throw err;
    }
    return this.get(actor, id.toHexString());
  }

  private referenceKey(actor: Actor, id: string) {
    return `ref/${actor.workspaceId.toHexString()}/${id}.png`;
  }

  private async loadReference(
    actor: Actor,
    id: string,
  ): Promise<{ key: string; name: string; bytes: Buffer }> {
    if (!/^[a-f0-9]{24}$/.test(id))
      throw new AppError(
        'not_found',
        'That reference image has expired. Add it again.',
        HttpStatus.NOT_FOUND,
      );
    const key = this.referenceKey(actor, id);
    const stored = await this.storage.get(key);
    if (!stored)
      throw new AppError(
        'not_found',
        'That reference image has expired. Add it again.',
        HttpStatus.NOT_FOUND,
      );
    const name = (await this.storage.get(`${key}.name`))?.bytes.toString() ?? 'reference.png';
    return { key, name, bytes: stored.bytes };
  }

  private async canUse(model: string, plan: Plan) {
    try {
      await this.models.resolveImage(model, plan, { needsImageInput: true });
      return true;
    } catch {
      return false;
    }
  }

  private async sourceImage(actor: Actor, id: string, index: number) {
    const gen = await this.find(actor, id);
    const item = gen.images[index];
    if (!item || item.status !== 'done' || !item.key) throw notFound();
    const stored = await this.storage.get(item.key);
    if (!stored) throw notFound();
    return { gen, bytes: stored.bytes, width: item.width ?? 1024, height: item.height ?? 1024 };
  }

  async cancel(actor: Actor, id: string): Promise<ImageGenerationDto> {
    const gen = await this.find(actor, id);
    if (gen.status === 'generating') {
      await this.gens.updateOne({ _id: gen._id }, { $set: { cancelRequested: true } });
      this.running.get(id)?.abort();
    }
    return this.get(actor, id);
  }

  async get(actor: Actor, id: string): Promise<ImageGenerationDto> {
    return this.toDto(await this.find(actor, id));
  }

  async list(actor: Actor, opts: { cursor?: string; q?: string }): Promise<ImageListDto> {
    const before = opts.cursor && Number.isFinite(Number(opts.cursor)) ? new Date(Number(opts.cursor)) : null;
    const q = opts.q?.trim();
    const rows = await this.gens
      .find(
        scoped<ImageGeneration>(actor.workspaceId, {
          ...(before && { createdAt: { $lt: before } }),
          ...(q && { prompt: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }),
        }),
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(PAGE + 1)
      .lean<GenLean[]>();
    const page = rows.slice(0, PAGE);
    return {
      items: await Promise.all(page.map((g) => this.toDto(g))),
      nextCursor: rows.length > PAGE ? String(new Date(page[page.length - 1]!.createdAt).getTime()) : null,
    };
  }

  /** The image file (or its preview), optionally converted for download. */
  async file(
    actor: Actor,
    id: string,
    index: number,
    opts: { variant?: 'full' | 'thumb'; format?: 'png' | 'jpg' | 'webp' },
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const gen = await this.find(actor, id);
    const item = gen.images[index];
    if (!item || item.status !== 'done' || !item.key) throw notFound();
    const key = opts.variant === 'thumb' && item.thumbKey ? item.thumbKey : item.key;
    const stored = await this.storage.get(key);
    if (!stored) throw notFound();
    const base = `${
      gen.title
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'image'
    }-${index + 1}`;
    if (opts.variant === 'thumb') return { ...stored, filename: `${base}.webp` };
    if (opts.format === 'jpg')
      return {
        bytes: await sharp(stored.bytes).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer(),
        contentType: 'image/jpeg',
        filename: `${base}.jpg`,
      };
    if (opts.format === 'webp')
      return {
        bytes: await sharp(stored.bytes).webp({ quality: 85 }).toBuffer(),
        contentType: 'image/webp',
        filename: `${base}.webp`,
      };
    return { ...stored, filename: `${base}.${stored.contentType === 'image/png' ? 'png' : 'img'}` };
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const gen = await this.find(actor, id);
    if (gen.status === 'generating') await this.cancel(actor, id);
    await this.gens.updateOne({ _id: gen._id }, { $set: { deletedAt: new Date() } });
    for (const img of gen.images) {
      if (img.key) await this.storage.delete(img.key).catch(() => undefined);
      if (img.thumbKey) await this.storage.delete(img.thumbKey).catch(() => undefined);
    }
  }

  /** Batches cut off by a restart: return their credits and close them. */
  async sweep(now = new Date()): Promise<number> {
    const stale = await this.gens
      .find({ status: 'generating', updatedAt: { $lt: new Date(now.getTime() - STALE_MS) } })
      .limit(50)
      .lean<GenLean[]>();
    for (const g of stale) {
      if (this.running.has(g._id.toHexString())) continue;
      if (g.holdId)
        await this.credits
          .release({ workspaceId: g.workspaceId, holdId: g.holdId, reason: 'Image batch interrupted' })
          .catch((err: unknown) => this.logger.error({ err }, 'Releasing an interrupted image batch failed'));
      const ok = g.images.filter((i) => i.status === 'done').length;
      await this.gens.updateOne(
        { _id: g._id, status: 'generating' },
        {
          $set: {
            status: ok ? 'partial' : 'failed',
            images: g.images.map((i) => (i.status === 'waiting' ? { ...i, status: 'cancelled' } : i)),
            error: {
              code: 'service_unavailable',
              message: 'Generating was interrupted. You weren’t charged.',
            },
          },
          $unset: { holdId: 1 },
        },
      );
    }
    return stale.length;
  }

  private async saveImage(actor: Actor, id: Types.ObjectId, i: number, r: ImageResult) {
    if ('bytes' in r) {
      const meta = await sharp(r.bytes).metadata();
      const base = `img/${actor.workspaceId.toHexString()}/${id.toHexString()}/${i}`;
      const png = r.mediaType === 'image/png' ? r.bytes : await sharp(r.bytes).png().toBuffer();
      const thumb = await sharp(r.bytes)
        .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside' })
        .webp({ quality: 80 })
        .toBuffer();
      await this.storage.put(`${base}.png`, png, 'image/png');
      await this.storage.put(`${base}-thumb.webp`, thumb, 'image/webp');
      await this.gens.updateOne(
        { _id: id },
        {
          $set: {
            [`images.${i}`]: {
              status: 'done',
              key: `${base}.png`,
              thumbKey: `${base}-thumb.webp`,
              width: meta.width,
              height: meta.height,
              mediaType: 'image/png',
              bytes: png.length,
            },
          },
        },
      );
    } else {
      await this.gens.updateOne(
        { _id: id },
        { $set: { [`images.${i}`]: { status: 'failed' in r ? 'failed' : 'cancelled' } } },
      );
    }
  }

  private async find(actor: Actor, id: string): Promise<GenLean> {
    const g = await this.gens
      .findOne(scoped<ImageGeneration>(actor.workspaceId, { _id: oid(id) }))
      .lean<GenLean>();
    if (!g) throw notFound();
    return g;
  }

  private async toDto(g: GenLean): Promise<ImageGenerationDto> {
    const id = g._id.toHexString();
    return {
      id,
      prompt: g.prompt,
      title: g.title || imageTitle(g.prompt),
      negative: g.negative ?? '',
      requestedModel: g.requestedModel ?? AUTO,
      model: g.model ?? null,
      modelName:
        g.kind === 'upscale'
          ? 'Upscale'
          : g.kind === 'cutout'
            ? 'Remove background'
            : await this.models.nameOf(g.model),
      auto: !!g.auto,
      ratio: g.ratio as ImageRatio,
      count: g.count,
      hd: !!g.hd,
      style: g.style ?? 'none',
      status: g.status,
      images: g.images.map((img, index) => ({
        index,
        status: img.status,
        width: img.width ?? null,
        height: img.height ?? null,
        url: img.status === 'done' ? `/api/images/${id}/files/${index}` : null,
        thumbUrl: img.status === 'done' ? `/api/images/${id}/files/${index}?variant=thumb` : null,
      })),
      credits: g.credits ?? 0,
      kind: g.kind ?? 'generate',
      source: g.source ? { id: String(g.source.id), index: g.source.index } : null,
      reference: g.reference ? { name: g.reference.name, use: g.reference.use } : null,
      error: g.error ?? null,
      createdAt: new Date(g.createdAt).toISOString(),
      updatedAt: new Date(g.updatedAt).toISOString(),
    };
  }
}

/**
 * The person's mask (white or opaque = change this) → the provider's: same size as the image,
 * transparent where it should change.
 */
export async function providerMask(mask: Buffer, width: number, height: number): Promise<Buffer> {
  let grey: Buffer;
  try {
    const resized = () => sharp(mask).resize(width, height, { fit: 'fill' });
    const meta = await sharp(mask).metadata();
    // Opaque-on-transparent masks use alpha; black-and-white ones use brightness.
    const alpha = meta.hasAlpha ? await resized().ensureAlpha().extractChannel(3).raw().toBuffer() : null;
    grey =
      alpha && alpha.some((v) => v < 128)
        ? alpha
        : await resized().flatten({ background: '#000' }).greyscale().extractChannel(0).raw().toBuffer();
  } catch {
    throw new AppError(
      'validation_failed',
      'The selection couldn’t be read. Select the area again.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  let marked = 0;
  const alpha = Buffer.alloc(grey.length);
  for (let i = 0; i < grey.length; i++) {
    const on = grey[i]! > 127;
    if (on) marked++;
    alpha[i] = on ? 0 : 255;
  }
  if (marked < grey.length * 0.002)
    throw new AppError(
      'validation_failed',
      'Select the area you want to change first.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
