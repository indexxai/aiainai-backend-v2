import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import { AiModel, type MODEL_KINDS } from '../database/schemas/ai-model.schema.js';
import type { Plan } from '../database/schemas/workspace.schema.js';
import type { ModelMenuDto } from './models.dto.js';
import {
  allowedOn,
  AUTO,
  isServable,
  pickAuto,
  pickAutoImage,
  requiredPlan,
  routeOf,
  type ModelInfo,
} from './models.logic.js';
import { ImageTools } from './image-tools.js';
import { demoEnabled, ProviderRegistry } from './providers.js';

type Kind = (typeof MODEL_KINDS)[number];

const CACHE_MS = 30_000;

/** The model registry as the app sees it: what to show in menus and which model answers. */
@Injectable()
export class ModelsService {
  readonly providers: ProviderRegistry;
  readonly imageTools: ImageTools;
  private cache?: { at: number; models: ModelInfo[] };

  constructor(
    @InjectModel(AiModel.name) private readonly models: Model<AiModel>,
    config: ConfigService<Env, true>,
  ) {
    const keys = {
      openai: config.get('OPENAI_API_KEY', { infer: true }),
      anthropic: config.get('ANTHROPIC_API_KEY', { infer: true }),
      openrouter: config.get('OPENROUTER_API_KEY', { infer: true }),
    };
    const demo = demoEnabled(
      { NODE_ENV: config.get('NODE_ENV', { infer: true }), AI_DEMO: config.get('AI_DEMO', { infer: true }) },
      keys,
    );
    this.providers = new ProviderRegistry(keys, demo);
    this.imageTools = new ImageTools({
      stabilityKey: config.get('STABILITY_API_KEY', { infer: true }),
      stabilityUpscalePath: config.get('STABILITY_UPSCALE_PATH', { infer: true }),
      stabilityCutoutPath: config.get('STABILITY_CUTOUT_PATH', { infer: true }),
      demo,
    });
  }

  get demo(): boolean {
    return this.providers.availability.demo;
  }

  /** Registry entries that can answer right now, in menu order. Cached briefly; Admin edits show within 30s. */
  async servable(kind: Kind): Promise<ModelInfo[]> {
    return (await this.all()).filter((m) => m.kind === kind && isServable(m, this.providers.availability));
  }

  /** Display name for a model key (for answers written by a model that is no longer offered). */
  async nameOf(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    return (await this.all()).find((m) => m.key === key)?.name ?? key;
  }

  /** True for a model key in the catalog, even if it can't be used right now. */
  private async known(key: string): Promise<boolean> {
    return (await this.all()).some((m) => m.key === key);
  }

  private async all(): Promise<ModelInfo[]> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const models = await this.models
        .find({ status: { $ne: 'paused' } })
        .sort({ sortOrder: 1 })
        .lean<ModelInfo[]>();
      this.cache = { at: Date.now(), models };
    }
    return this.cache.models;
  }

  async menu(kind: Kind, plan: Plan, preferred: string): Promise<ModelMenuDto> {
    const models = await this.servable(kind);
    const valid = models.some((m) => m.key === preferred && allowedOn(m, plan));
    return {
      kind,
      auto: {
        key: AUTO,
        name: 'Auto',
        description:
          kind === 'text'
            ? 'Picks the best model for each request'
            : 'Picks the best image model for your prompt',
        tags: ['Balanced', 'Credits vary'],
      },
      models: models.map((m) => ({
        key: m.key,
        name: m.name,
        provider: m.provider,
        description: m.description,
        tags: m.tags,
        credits: m.credits,
        locked: !allowedOn(m, plan),
        requiredPlan: requiredPlan(m),
      })),
      selected: valid ? preferred : AUTO,
      demo: this.demo,
    };
  }

  /**
   * The model that will answer: the requested one, or Auto's pick.
   * Throws `upgrade_required` for a model outside the plan and `model_unavailable` otherwise.
   */
  async resolve(
    requested: string,
    plan: Plan,
    prompt: { chars: number; hasFiles?: boolean },
    opts: { tried?: readonly string[]; openrouterOnly?: boolean } = {},
  ): Promise<{ model: ModelInfo; auto: boolean }> {
    const all = await this.servable('text');
    const models = all.filter(
      (m) => !opts.openrouterOnly || routeOf(m, this.providers.availability) === 'openrouter',
    );
    if (requested === AUTO) {
      const model = pickAuto(models, plan, prompt, opts.tried);
      if (!model) throw unavailable();
      return { model, auto: true };
    }
    const model = models.find((m) => m.key === requested);
    if (!model) throw (await this.known(requested)) ? unavailable() : unknownModel();
    if (!allowedOn(model, plan))
      throw new AppError(
        'upgrade_required',
        `${model.name} is on the Jack Personal plan.`,
        HttpStatus.FORBIDDEN,
        {
          model: model.key,
          requiredPlan: requiredPlan(model),
        },
      );
    return { model, auto: false };
  }

  /** Can a text model search the web here (OpenRouter's web search needs a model routed through it)? */
  async canWebSearch(): Promise<boolean> {
    if (this.providers.availability.demo) return false;
    return (await this.servable('text')).some(
      (m) => routeOf(m, this.providers.availability) === 'openrouter',
    );
  }

  /** The image model that will draw: the requested one, or Auto's pick for the style. */
  async resolveImage(
    requested: string,
    plan: Plan,
    opts: { style?: string; needsImageInput?: boolean },
  ): Promise<{ model: ModelInfo; auto: boolean }> {
    const all = await this.servable('image');
    // Edits, variations and reference images need a model that takes an image as input.
    const models = opts.needsImageInput ? all.filter((m) => this.providers.takesImageInput(m)) : all;
    if (requested === AUTO) {
      const model = pickAutoImage(models, plan, opts.style);
      if (!model) throw opts.needsImageInput && all.length ? noImageInput() : unavailable();
      return { model, auto: true };
    }
    const model = models.find((m) => m.key === requested);
    if (!model)
      throw all.some((m) => m.key === requested)
        ? noImageInput()
        : (await this.known(requested))
          ? unavailable()
          : unknownModel();
    if (!allowedOn(model, plan))
      throw new AppError(
        'upgrade_required',
        `${model.name} is on the Jack Personal plan.`,
        HttpStatus.FORBIDDEN,
        {
          model: model.key,
          requiredPlan: requiredPlan(model),
        },
      );
    return { model, auto: false };
  }

  /** For Settings and the menu: is this a model the person may pick as their default? */
  async assertSelectable(key: string, plan: Plan): Promise<void> {
    if (key === AUTO) return;
    await this.resolve(key, plan, { chars: 0 });
  }

  /** Drop the cache (after `models:configure` or an Admin edit in the same process). */
  invalidate(): void {
    this.cache = undefined;
  }
}

const noImageInput = () =>
  new AppError(
    'model_unavailable',
    'This model can’t work from an existing image. Pick Auto or GPT Image.',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );

/** A key that isn't a model at all is a bad request, not a temporary outage. */
const unknownModel = () =>
  new AppError(
    'validation_failed',
    'We don’t know that model. Pick Auto or another model.',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );

const unavailable = () =>
  new AppError(
    'model_unavailable',
    'That model isn’t available right now. Try Auto or another model.',
    HttpStatus.SERVICE_UNAVAILABLE,
  );
