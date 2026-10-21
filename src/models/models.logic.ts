import type { AiModel } from '../database/schemas/ai-model.schema.js';
import type { Plan } from '../database/schemas/workspace.schema.js';

/** The registry fields the menus and the gateway need (a lean `ai_models` document). */
export type ModelInfo = Pick<
  AiModel,
  | 'key'
  | 'kind'
  | 'name'
  | 'provider'
  | 'providerModelId'
  | 'description'
  | 'tags'
  | 'credits'
  | 'plans'
  | 'autoEligible'
  | 'status'
  | 'sortOrder'
  | 'inputPriceMicros'
  | 'outputPriceMicros'
> & { openrouterModelId?: string };

/**
 * Model makers. Each one can be switched off for a Business space ("never send company data to
 * this provider"), so this list is also what Connections shows.
 */
export const PROVIDERS = ['openai', 'anthropic', 'google', 'deepseek', 'moonshot', 'qwen'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Gemini',
  deepseek: 'DeepSeek',
  moonshot: 'Kimi',
  qwen: 'Qwen',
};

/** Providers the gateway can also call with their own key (everything else goes through OpenRouter). */
export const DIRECT_PROVIDERS: readonly ProviderId[] = ['openai', 'anthropic'];

export const AUTO = 'auto';

export function providerIdOf(provider: string): ProviderId | null {
  const p = provider.toLowerCase();
  if (p === 'openai') return 'openai';
  if (p === 'anthropic') return 'anthropic';
  if (p === 'google' || p === 'gemini') return 'google';
  if (p === 'deepseek') return 'deepseek';
  if (p === 'moonshot ai' || p === 'moonshot' || p === 'kimi') return 'moonshot';
  if (p === 'qwen' || p === 'alibaba' || p === 'alibaba cloud') return 'qwen';
  return null;
}

export interface Availability {
  /** Stand-in model answers for every model (local development without keys). */
  demo: boolean;
  /** Providers with their own API key set. */
  keys: ReadonlySet<ProviderId>;
  /** An OpenRouter key is set: one key that reaches every provider. */
  openrouter?: boolean;
}

export type Route = 'openrouter' | 'direct';

/**
 * How a model is called: through OpenRouter when it has an OpenRouter model id and the key is
 * set (one key, one bill), otherwise directly with the provider's own key.
 */
export function routeOf(m: ModelInfo, av: Availability): Route | null {
  if (av.openrouter && m.openrouterModelId) return 'openrouter';
  const provider = providerIdOf(m.provider);
  if (provider && DIRECT_PROVIDERS.includes(provider) && av.keys.has(provider) && m.providerModelId)
    return 'direct';
  return null;
}

/**
 * Can the gateway serve this model right now? Live, with a model id for a route that has a key.
 * In demo mode every model that isn't paused is served by the stand-in.
 */
export function isServable(m: ModelInfo, av: Availability): boolean {
  if (m.status === 'paused') return false;
  if (av.demo) return true;
  return m.status === 'live' && routeOf(m, av) !== null;
}

export const allowedOn = (m: Pick<ModelInfo, 'plans'>, plan: Plan) => m.plans.includes(plan);

/** Cheapest plan that includes the model, for the "Pro" badge. */
export function requiredPlan(m: Pick<ModelInfo, 'plans'>): Plan {
  return m.plans.includes('free') ? 'free' : 'pro';
}

/**
 * Auto: a rule anyone can read, not a black box.
 * Short, simple prompts go to a fast model; everything else to a balanced one.
 * Only models on the person's plan are considered, so Auto never needs an upgrade.
 */
export const AUTO_PREFERENCE = {
  quick: ['claude-haiku', 'gpt-mini', 'gemini-flash', 'claude-sonnet', 'gpt'],
  balanced: ['claude-sonnet', 'gpt', 'gemini-pro', 'gpt-mini', 'claude-haiku'],
} as const;

export const QUICK_PROMPT_CHARS = 280;

/**
 * `tried` lists models that already failed this request. The fallback then goes cheaper: the
 * preferred model priced below every failed one, else the cheapest model left.
 */
export function pickAuto(
  servable: ModelInfo[],
  plan: Plan,
  prompt: { chars: number; hasFiles?: boolean },
  tried?: readonly string[],
): ModelInfo | null {
  const candidates = servable.filter(
    (m) => m.kind === 'text' && m.autoEligible && allowedOn(m, plan) && !tried?.includes(m.key),
  );
  if (!candidates.length) return null;
  const failed = tried?.length ? servable.filter((m) => tried.includes(m.key)) : [];
  const below = failed.length ? Math.min(...failed.map((m) => m.credits)) : Infinity;
  const quick = prompt.chars <= QUICK_PROMPT_CHARS && !prompt.hasFiles;
  for (const key of quick ? AUTO_PREFERENCE.quick : AUTO_PREFERENCE.balanced) {
    const hit = candidates.find((m) => m.key === key && m.credits < below);
    if (hit) return hit;
  }
  return [...candidates].sort((a, b) => a.credits - b.credits || a.sortOrder - b.sortOrder)[0]!;
}

/** Provider cost of one call in micro-dollars, from registry prices per million tokens. */
export function costMicros(m: ModelInfo, usage: { inputTokens: number; outputTokens: number }): number {
  return Math.round(
    (usage.inputTokens * (m.inputPriceMicros ?? 0) + usage.outputTokens * (m.outputPriceMicros ?? 0)) / 1e6,
  );
}

/**
 * Auto for images, by style: photos to the most realistic model, illustrations and flat art to
 * the most stylised, anything else to the best all-rounder. Only models on the plan.
 */
export const AUTO_IMAGE_PREFERENCE: Record<string, readonly string[]> = {
  photo: ['imagen', 'gpt-image', 'flux', 'seedream'],
  illustration: ['flux', 'gpt-image', 'seedream', 'imagen'],
  '3d': ['flux', 'gpt-image', 'imagen', 'seedream'],
  flat: ['flux', 'gpt-image', 'seedream', 'imagen'],
  none: ['gpt-image', 'imagen', 'flux', 'seedream'],
};

export function pickAutoImage(servable: ModelInfo[], plan: Plan, style = 'none'): ModelInfo | null {
  const candidates = servable.filter((m) => m.kind === 'image' && m.autoEligible && allowedOn(m, plan));
  for (const key of AUTO_IMAGE_PREFERENCE[style] ?? AUTO_IMAGE_PREFERENCE.none!) {
    const hit = candidates.find((m) => m.key === key);
    if (hit) return hit;
  }
  return candidates[0] ?? null;
}
