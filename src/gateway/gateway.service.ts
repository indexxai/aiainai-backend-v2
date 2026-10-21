import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { generateImage, generateText, Output, streamText, type ModelMessage } from 'ai';
import type { z } from 'zod';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { CreditsService } from '../credits/credits.service.js';
import { UsageEvent } from '../database/schemas/usage-event.schema.js';
import { Workspace, type Plan } from '../database/schemas/workspace.schema.js';
import { costMicros, type ModelInfo } from '../models/models.logic.js';
import { ModelsService } from '../models/models.service.js';
import type { ImageToolId } from '../models/image-tools.js';
import type { ImageRatio } from '../models/providers.js';

export interface GatewayRequest {
  /** The space's workspace (Personal or Business). Credits come from the person's one plan. */
  workspaceId: Types.ObjectId | string;
  userId: string;
  plan: Plan;
  /** Which tool is asking: chat, docs, research, team, files. Recorded on the usage event. */
  tool: string;
  /** A model key, or "auto". */
  model: string;
  system?: string;
  messages: ModelMessage[];
  /** Unique per message (e.g. the message id). Retrying with the same key never charges twice. */
  key: string;
  ref?: { kind: string; id: string };
  requestId?: string;
  /** Aborting (the Stop button, a closed tab) ends the call; see `charge` rules below. */
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  /**
   * Credits for this call instead of the model's per-message price (e.g. a document costs the
   * model price × a length factor). `onStop` decides the charge when stopped part-way.
   */
  price?: { credits: number; onStop?: (textSoFar: string) => number };
  /** Added to the price for long inputs, e.g. attached files (1 credit per ~40,000 characters). */
  extraCredits?: number;
}

export type GatewayEvent =
  | {
      type: 'start';
      model: { key: string; name: string; provider: string };
      auto: boolean;
      credits: number;
    }
  | { type: 'text'; delta: string }
  | {
      type: 'finish';
      outcome: 'ok' | 'stopped';
      /** Credits charged for this message (0 when stopped before any answer). */
      credits: number;
      usage: { inputTokens: number; outputTokens: number };
    };

/**
 * One way to call any model. Every call:
 * 1. resolves the model (Auto picks one) and checks the plan,
 * 2. holds the message's credits before the provider is called (not enough → 402, nothing sent),
 * 3. streams text,
 * 4. settles: charges the credits if an answer was produced, otherwise returns them,
 * 5. writes a usage event (tokens, provider cost, latency, outcome).
 *
 * Charge rules: a finished answer is charged; a stopped answer is charged only if text had
 * already arrived (the provider billed us for it); a failed call is never charged.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly models: ModelsService,
    private readonly credits: CreditsService,
    @InjectModel(UsageEvent.name) private readonly usage: Model<UsageEvent>,
    @Optional() @InjectModel(Workspace.name) private readonly workspaces?: Model<Workspace>,
  ) {}

  /**
   * Who pays. A Business space has no credits of its own: it spends from the owner's plan (one
   * shared pool). The request is rewritten so credits and usage go to the paying workspace; the
   * space is kept on the usage event for the per-space split.
   */
  private async scope<T extends { workspaceId: Types.ObjectId | string }>(
    req: T,
  ): Promise<{ req: T & { spaceWorkspaceId: string } }> {
    const space = String(req.workspaceId);
    const ws = this.workspaces
      ? await this.workspaces
          .findById(space, { kind: 1, parentWorkspaceId: 1 })
          .lean<Pick<Workspace, 'kind' | 'parentWorkspaceId'>>()
      : null;
    const payer = ws?.kind === 'business' && ws.parentWorkspaceId ? ws.parentWorkspaceId : req.workspaceId;
    return { req: { ...req, workspaceId: payer, spaceWorkspaceId: space } };
  }

  /**
   * The model for this attempt. After a failed Auto attempt, running out of other models means
   * the request failed at the provider, so that is what's reported (not "model unavailable").
   */
  private async resolveAttempt(req: Pick<GatewayRequest, 'model' | 'plan'>, chars: number, tried: string[]) {
    try {
      return await this.models.resolve(req.model, req.plan, { chars }, { tried });
    } catch (err) {
      if (tried.length && err instanceof AppError && err.code === 'model_unavailable')
        throw toGatewayError(null);
      throw err;
    }
  }

  async *stream(input: GatewayRequest): AsyncGenerator<GatewayEvent> {
    const { req } = await this.scope(input);
    const chars = promptChars(req.messages);
    const ref = req.ref ?? { kind: req.tool, id: req.key };
    // Models already tried and failed this request, so Auto moves on to the next-best one.
    const tried: string[] = [];

    for (let attempt = 1; ; attempt++) {
      const { model, auto } = await this.resolveAttempt(req, chars, tried);
      const { holdId } = await this.credits.hold({
        workspaceId: req.workspaceId,
        amount: priceOf(req, model),
        key: holdKey(req.key, attempt),
        reason: `${model.name} · ${req.tool}`,
        ref,
      });

      const started = Date.now();
      const upstream = new AbortController();
      const onAbort = () => upstream.abort(req.abortSignal?.reason);
      req.abortSignal?.addEventListener('abort', onAbort, { once: true });

      let state: 'running' | 'ok' | 'stopped' | 'failed' = 'running';
      let produced = false;
      let written = '';
      let finished = false;
      let tokens = { inputTokens: 0, outputTokens: 0 };
      let charged = 0;
      let failure: unknown;

      try {
        yield {
          type: 'start',
          model: { key: model.key, name: model.name, provider: model.provider },
          auto,
          credits: priceOf(req, model),
        };
        if (req.abortSignal?.aborted) upstream.abort(req.abortSignal.reason);

        const result = streamText({
          model: this.models.providers.languageModel(model),
          system: req.system,
          messages: req.messages,
          abortSignal: upstream.signal,
          maxOutputTokens: req.maxOutputTokens,
          maxRetries: 1,
        });

        let aborted = false;
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta' && part.text) {
            produced = true;
            written += part.text;
            yield { type: 'text', delta: part.text };
          } else if (part.type === 'finish') {
            tokens = {
              inputTokens: part.totalUsage.inputTokens ?? 0,
              outputTokens: part.totalUsage.outputTokens ?? 0,
            };
            finished = true;
          } else if (part.type === 'abort') {
            aborted = true;
          } else if (part.type === 'error') {
            throw part.error;
          }
        }
        state = finished && !aborted ? 'ok' : 'stopped';
      } catch (err) {
        if (upstream.signal.aborted) {
          state = 'stopped';
        } else {
          state = 'failed';
          failure = err;
        }
      } finally {
        // Runs on success, on failure, and when the caller stops reading (Stop, closed tab).
        req.abortSignal?.removeEventListener('abort', onAbort);
        if (state === 'running') {
          state = 'stopped';
          upstream.abort();
        }
        charged = await this.finish(req, model, holdId, ref, {
          actual:
            state === 'ok'
              ? priceOf(req, model)
              : state === 'stopped' && produced
                ? stopCharge(req, model, written)
                : 0,
          outcome: state,
          tokens,
          latencyMs: Date.now() - started,
          auto,
        });
      }

      // Auto, nothing written yet, and another model is worth a try: move on without
      // surfacing this attempt's failure to the caller.
      if (state === 'failed' && auto && !produced && attempt < MAX_AUTO_ATTEMPTS) {
        this.logger.warn(
          { err: failure, model: model.key, requestId: req.requestId },
          'Model call failed; Auto is trying the next model',
        );
        tried.push(model.key);
        continue;
      }
      if (state === 'failed') {
        this.logger.warn({ err: failure, model: model.key, requestId: req.requestId }, 'Model call failed');
        throw toGatewayError(failure);
      }
      yield { type: 'finish', outcome: state, credits: charged, usage: tokens };
      return;
    }
  }

  /**
   * One call that returns structured data (e.g. a document outline), validated against `schema`.
   * Same rules as `stream`: credits are held first, charged on success, returned on failure.
   */
  async object<T>(
    input: Omit<GatewayRequest, 'price'> & {
      schema: z.ZodType<T>;
      price?: { credits: number };
    },
  ): Promise<{
    object: T;
    model: { key: string; name: string; provider: string };
    auto: boolean;
    credits: number;
  }> {
    const { req } = await this.scope(input);
    const chars = promptChars(req.messages);
    const ref = req.ref ?? { kind: req.tool, id: req.key };
    const tried: string[] = [];

    for (let attempt = 1; ; attempt++) {
      const { model, auto } = await this.resolveAttempt(req, chars, tried);
      const amount = priceOf(req, model);
      // Free calls (e.g. Improve prompt) reserve nothing but are still recorded as usage.
      const { holdId } =
        amount > 0
          ? await this.credits.hold({
              workspaceId: req.workspaceId,
              amount,
              key: holdKey(req.key, attempt),
              reason: `${model.name} · ${req.tool}`,
              ref,
            })
          : { holdId: '' };
      const started = Date.now();
      try {
        const result = await generateText({
          model: this.models.providers.languageModel(model),
          system: req.system,
          messages: req.messages,
          output: Output.object({ schema: req.schema }),
          abortSignal: req.abortSignal,
          maxOutputTokens: req.maxOutputTokens,
          maxRetries: 1,
        });
        const tokens = {
          inputTokens: result.totalUsage.inputTokens ?? 0,
          outputTokens: result.totalUsage.outputTokens ?? 0,
        };
        const charged = await this.finish(req, model, holdId, ref, {
          actual: amount,
          outcome: 'ok',
          tokens,
          latencyMs: Date.now() - started,
          auto,
        });
        return {
          object: result.output as T,
          model: { key: model.key, name: model.name, provider: model.provider },
          auto,
          credits: charged,
        };
      } catch (err) {
        const stopped = !!req.abortSignal?.aborted;
        await this.finish(req, model, holdId, ref, {
          actual: 0,
          outcome: stopped ? 'stopped' : 'failed',
          tokens: { inputTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - started,
          auto,
        });
        if (!stopped && auto && attempt < MAX_AUTO_ATTEMPTS) {
          this.logger.warn(
            { err, model: model.key, requestId: req.requestId },
            'Model call failed; Auto is trying the next model',
          );
          tried.push(model.key);
          continue;
        }
        if (!stopped)
          this.logger.warn({ err, model: model.key, requestId: req.requestId }, 'Model call failed');
        throw toGatewayError(err);
      }
    }
  }

  /** Is web search available (a text model routed through OpenRouter)? */
  canWebSearch(): Promise<boolean> {
    return this.models.canWebSearch();
  }

  /**
   * A web search (OpenRouter's web plugin) for Jack's browser: the pages found, with a short
   * excerpt each. Charged as the model's price plus SEARCH_CREDITS for the search itself.
   * Only models routed through OpenRouter can search; Auto picks among those.
   */
  async webSearch(
    input: Omit<GatewayRequest, 'messages' | 'price' | 'system'> & { query: string; maxResults?: number },
  ): Promise<{ title: string; url: string; snippet: string }[]> {
    const { req } = await this.scope({ ...input, messages: [] });
    const ref = req.ref ?? { kind: req.tool, id: req.key };
    const tried: string[] = [];
    for (let attempt = 1; ; attempt++) {
      let picked: { model: ModelInfo; auto: boolean };
      try {
        picked = await this.models.resolve(
          req.model,
          req.plan,
          { chars: input.query.length },
          { tried, openrouterOnly: true },
        );
      } catch (err) {
        if (tried.length && err instanceof AppError && err.code === 'model_unavailable')
          throw toGatewayError(null);
        // The chosen model can't search: let Auto pick one that can.
        if (req.model !== 'auto') return this.webSearch({ ...input, model: 'auto' });
        throw err;
      }
      const { model, auto } = picked;
      const amount = model.credits + SEARCH_CREDITS;
      const { holdId } = await this.credits.hold({
        workspaceId: req.workspaceId,
        amount,
        key: holdKey(req.key, attempt),
        reason: `Web search · ${model.name}`,
        ref,
      });
      const started = Date.now();
      try {
        const result = await generateText({
          model: this.models.providers.languageModel(model),
          system:
            'Search the web for the request and list the best pages for it, one line each. Prefer the sites themselves (the restaurant, shop or airline) over lists of links.',
          messages: [{ role: 'user', content: input.query }],
          providerOptions: { openrouter: { plugins: [{ id: 'web', max_results: input.maxResults ?? 6 }] } },
          abortSignal: req.abortSignal,
          maxOutputTokens: 600,
          maxRetries: 1,
        });
        await this.finish(req, model, holdId, ref, {
          actual: amount,
          outcome: 'ok',
          tokens: {
            inputTokens: result.totalUsage.inputTokens ?? 0,
            outputTokens: result.totalUsage.outputTokens ?? 0,
          },
          latencyMs: Date.now() - started,
          auto,
        });
        const seen = new Set<string>();
        return result.sources
          .filter((s) => s.sourceType === 'url' && !seen.has(s.url) && seen.add(s.url))
          .map((s) => {
            const meta = (s.providerMetadata?.openrouter ?? {}) as { content?: unknown };
            return {
              title: (s.sourceType === 'url' && s.title) || '',
              url: s.sourceType === 'url' ? s.url : '',
              snippet: typeof meta.content === 'string' ? meta.content.slice(0, 300) : '',
            };
          });
      } catch (err) {
        const stopped = !!req.abortSignal?.aborted;
        await this.finish(req, model, holdId, ref, {
          actual: 0,
          outcome: stopped ? 'stopped' : 'failed',
          tokens: { inputTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - started,
          auto,
        });
        if (!stopped && auto && attempt < MAX_AUTO_ATTEMPTS) {
          this.logger.warn({ err, model: model.key }, 'Web search failed; Auto is trying the next model');
          tried.push(model.key);
          continue;
        }
        throw toGatewayError(err);
      }
    }
  }

  /**
   * A batch of images from one prompt. Credits for the whole batch are held first; each image
   * that comes back is charged, images that fail or are cancelled are not. If the provider
   * blocks the prompt, nothing more is tried and nothing is charged for it.
   */
  async imageBatch(input: ImageBatchRequest): Promise<ImageBatchResult> {
    const { req } = await this.scope(input);
    const { model, auto } = await this.models.resolveImage(req.model, req.plan, {
      style: req.style,
      needsImageInput: !!req.images?.length,
    });
    const ref = req.ref ?? { kind: 'image', id: req.key };
    const total = model.credits * req.count;
    const { holdId } = await this.credits.hold({
      workspaceId: req.workspaceId,
      amount: total,
      key: `ai:${req.key}`,
      reason: `${model.name} · ${req.count} image${req.count === 1 ? '' : 's'}`,
      ref,
    });
    await req.onStart?.({
      model: { key: model.key, name: model.name, provider: model.provider },
      auto,
      holdId,
      credits: total,
    });

    const started = Date.now();
    const call = this.models.providers.imageCall(model, req.ratio, req.hd);
    let ok = 0;
    let blocked: string | null = null;
    let next = 0;
    let charged = 0;
    const work = async () => {
      while (next < req.count) {
        const i = next++;
        if (blocked || (await req.cancelled?.())) {
          await req.onImage(i, { skipped: true });
          continue;
        }
        try {
          const result = await generateImage({
            model: this.models.providers.imageModel(model),
            prompt: req.images?.length
              ? { text: req.prompt, images: req.images.map((f) => f.bytes), mask: req.mask }
              : req.prompt,
            n: 1,
            ...call,
            seed: req.seed !== undefined ? req.seed + i : undefined,
            providerOptions: call.providerOptions,
            abortSignal: req.abortSignal,
            maxRetries: 1,
          });
          ok++;
          await req.onImage(i, {
            bytes: Buffer.from(result.image.uint8Array),
            mediaType: result.image.mediaType,
          });
        } catch (err) {
          if (req.abortSignal?.aborted) {
            await req.onImage(i, { skipped: true });
            continue;
          }
          if (isBlocked(err))
            blocked = 'This prompt can’t be made into an image. Try describing it differently.';
          else
            this.logger.warn({ err, model: model.key, requestId: req.requestId }, 'Image generation failed');
          await req.onImage(i, blocked ? { skipped: true } : { failed: true });
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, req.count) }, work));
    } finally {
      charged = await this.finish(
        { ...req, tool: 'image', messages: [] } as unknown as GatewayRequest,
        model,
        holdId,
        ref,
        {
          actual: model.credits * ok,
          outcome: blocked ? 'blocked' : ok === req.count ? 'ok' : ok > 0 ? 'ok' : 'failed',
          tokens: { inputTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - started,
          auto,
          images: ok,
          providerCostMicros: (model.outputPriceMicros ?? 0) * ok,
        },
      );
    }
    return {
      model: { key: model.key, name: model.name, provider: model.provider },
      auto,
      ok,
      blocked,
      credits: charged,
    };
  }

  /**
   * An image tool with a fixed price (Upscale, Remove background): credits are held, the tool
   * runs, and the result is charged; a failure returns the credits. Recorded as usage like a model.
   */
  async imageTool(input: {
    workspaceId: Types.ObjectId | string;
    userId: string;
    tool: ImageToolId;
    credits: number;
    input: Buffer;
    key: string;
    ref: { kind: string; id: string };
    requestId?: string;
    abortSignal?: AbortSignal;
    onStart?: (info: { holdId: string }) => Promise<void> | void;
  }): Promise<{ result: { bytes: Buffer; mediaType: string }; credits: number }> {
    const { req } = await this.scope(input);
    const tools = this.models.imageTools;
    if (!tools.provider || !tools.available[req.tool])
      throw new AppError('model_unavailable', 'This tool isn’t available right now.', 503);
    const name = req.tool === 'upscale' ? 'Upscale' : 'Remove background';
    const { holdId } = await this.credits.hold({
      workspaceId: req.workspaceId,
      amount: req.credits,
      key: `ai:${req.key}`,
      reason: name,
      ref: req.ref,
    });
    await req.onStart?.({ holdId });
    const started = Date.now();
    const pseudo = {
      key: req.tool,
      name,
      provider: tools.provider,
      credits: req.credits,
    } as unknown as ModelInfo;
    const base = {
      ...req,
      tool: 'image',
      messages: [],
      plan: 'free',
      model: req.tool,
    } as unknown as GatewayRequest;
    try {
      const result = await tools.run(req.tool, req.input, req.abortSignal);
      const credits = await this.finish(base, pseudo, holdId, req.ref, {
        actual: req.credits,
        outcome: 'ok',
        tokens: { inputTokens: 0, outputTokens: 0 },
        latencyMs: Date.now() - started,
        auto: false,
        images: 1,
        providerCostMicros: 0,
      });
      return { result, credits };
    } catch (err) {
      await this.finish(base, pseudo, holdId, req.ref, {
        actual: 0,
        outcome: req.abortSignal?.aborted ? 'stopped' : 'failed',
        tokens: { inputTokens: 0, outputTokens: 0 },
        latencyMs: Date.now() - started,
        auto: false,
        images: 0,
        providerCostMicros: 0,
      });
      if (!req.abortSignal?.aborted) this.logger.warn({ err, tool: req.tool }, 'Image tool failed');
      throw toGatewayError(err);
    }
  }

  private async finish(
    req: GatewayRequest,
    model: ModelInfo,
    holdId: string,
    ref: { kind: string; id: string },
    r: {
      actual: number;
      outcome: 'ok' | 'stopped' | 'failed' | 'blocked';
      tokens: { inputTokens: number; outputTokens: number };
      latencyMs: number;
      auto: boolean;
      images?: number;
      providerCostMicros?: number;
    },
  ): Promise<number> {
    let charged = 0;
    try {
      const reason = `${model.name} · ${req.tool}`;
      if (!holdId) {
        // Nothing was reserved (a free call).
      } else if (r.actual > 0) {
        const s = await this.credits.settle({
          workspaceId: req.workspaceId,
          holdId,
          actual: r.actual,
          reason,
          ref,
        });
        charged = s.charged;
      } else {
        await this.credits.release({ workspaceId: req.workspaceId, holdId, reason, ref });
      }
    } catch (err) {
      // The hold stays in place and is visible in the ledger; never lose the answer over this.
      this.logger.error({ err, holdId, requestId: req.requestId }, 'Settling credits failed');
    }
    try {
      const space = (req as { spaceWorkspaceId?: string }).spaceWorkspaceId;
      await this.usage.create({
        workspaceId: new Types.ObjectId(String(req.workspaceId)),
        ...(space && space !== String(req.workspaceId)
          ? { spaceWorkspaceId: new Types.ObjectId(space) }
          : {}),
        userId: req.userId,
        tool: req.tool,
        modelKey: model.key,
        requestedModelKey: r.auto ? 'auto' : model.key,
        provider: this.models.demo ? 'demo' : model.provider,
        inputTokens: r.tokens.inputTokens,
        outputTokens: r.tokens.outputTokens,
        images: r.images ?? 0,
        providerCostMicros: this.models.demo ? 0 : (r.providerCostMicros ?? costMicros(model, r.tokens)),
        credits: charged,
        latencyMs: r.latencyMs,
        outcome: r.outcome,
        requestId: req.requestId,
      });
    } catch (err) {
      this.logger.error({ err, requestId: req.requestId }, 'Writing usage event failed');
    }
    return charged;
  }
}

const IMAGE_CONCURRENCY = 2;

export type ImageResult = { bytes: Buffer; mediaType: string } | { failed: true } | { skipped: true };

export interface ImageBatchRequest {
  workspaceId: Types.ObjectId | string;
  userId: string;
  plan: Plan;
  /** An image model key, or "auto". */
  model: string;
  style?: string;
  prompt: string;
  count: number;
  ratio: ImageRatio;
  hd: boolean;
  seed?: number;
  /** Start from these images (variations, edits, a reference). Needs a model that takes image input. */
  images?: { bytes: Buffer; mediaType: string }[];
  /** For edits: PNG, transparent where the image should change (OpenAI's convention). */
  mask?: Buffer;
  key: string;
  ref?: { kind: string; id: string };
  requestId?: string;
  abortSignal?: AbortSignal;
  onStart?: (info: {
    model: { key: string; name: string; provider: string };
    auto: boolean;
    holdId: string;
    credits: number;
  }) => Promise<void> | void;
  onImage: (index: number, result: ImageResult) => Promise<void> | void;
  /** Checked before each image (e.g. the person pressed Cancel, possibly on another server). */
  cancelled?: () => Promise<boolean> | boolean;
}

export interface ImageBatchResult {
  model: { key: string; name: string; provider: string };
  auto: boolean;
  ok: number;
  /** Set when the provider refused the prompt. */
  blocked: string | null;
  credits: number;
}

/** Provider safety refusals (not worth retrying, never charged). */
function isBlocked(err: unknown): boolean {
  const text = `${(err as { message?: string })?.message ?? ''} ${JSON.stringify((err as { data?: unknown })?.data ?? '')}`;
  return /safety|content[_ ]policy|moderation|rejected|not allowed/i.test(text);
}

/** How many models Auto tries for one request before giving up (the first pick plus fallbacks). */
/** Credits for one web search, on top of the model's price (the search itself costs about a cent). */
export const SEARCH_CREDITS = 1;
const MAX_AUTO_ATTEMPTS = 3;

/**
 * The ledger dedupes holds by key, so each Auto fallback (a different, differently priced
 * model) needs its own. The first attempt keeps the plain key, so ordinary calls are unchanged.
 */
const holdKey = (key: string, attempt: number) =>
  attempt === 1 ? `ai:${key}` : `ai:${key}:fallback-${attempt}`;

function priceOf(req: Pick<GatewayRequest, 'price' | 'extraCredits'>, model: ModelInfo): number {
  return (req.price?.credits ?? model.credits) + Math.max(0, Math.floor(req.extraCredits ?? 0));
}

function stopCharge(
  req: Pick<GatewayRequest, 'price' | 'extraCredits'>,
  model: ModelInfo,
  written: string,
): number {
  const full = priceOf(req, model);
  if (!req.price?.onStop) return full;
  return Math.max(0, Math.min(full, Math.ceil(req.price.onStop(written))));
}

function promptChars(messages: ModelMessage[]): number {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return 0;
  if (typeof last.content === 'string') return last.content.length;
  return last.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
}

/** Provider errors become one plain message; details stay in the server log. */
function toGatewayError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError(
    'service_unavailable',
    'The model didn’t answer. No credits were used; please try again.',
    503,
  );
}
