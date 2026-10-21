import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { ImageModel, LanguageModel, TranscriptionModel } from 'ai';
import { DemoImageModel } from './demo-image-model.js';
import { DemoLanguageModel } from './demo-model.js';
import { DemoTranscriptionModel } from './demo-transcription-model.js';
import { providerIdOf, routeOf, type Availability, type ModelInfo, type ProviderId } from './models.logic.js';

export interface ProviderKeys {
  openai?: string;
  anthropic?: string;
  /** One key for every model maker (OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen…). */
  openrouter?: string;
}

/**
 * Turns a registry entry into an AI SDK model. The only place that knows about provider SDKs,
 * so adding a provider (Google, OpenRouter) is one branch here plus its key in env.ts.
 */
export class ProviderRegistry {
  private readonly openai?: ReturnType<typeof createOpenAI>;
  private readonly anthropic?: ReturnType<typeof createAnthropic>;
  private readonly openrouter?: ReturnType<typeof createOpenRouter>;
  readonly availability: Availability;

  constructor(keys: ProviderKeys, demo: boolean) {
    if (keys.openai) this.openai = createOpenAI({ apiKey: keys.openai });
    if (keys.anthropic) this.anthropic = createAnthropic({ apiKey: keys.anthropic });
    if (keys.openrouter)
      this.openrouter = createOpenRouter({
        apiKey: keys.openrouter,
        appName: 'AI Station',
        appUrl: 'https://aiainai.ai',
      });
    const set = new Set<ProviderId>();
    if (keys.openai) set.add('openai');
    if (keys.anthropic) set.add('anthropic');
    this.availability = { demo, keys: set, openrouter: !!keys.openrouter };
  }

  languageModel(m: ModelInfo): LanguageModel {
    if (this.availability.demo) return new DemoLanguageModel(m.key, m.name);
    if (routeOf(m, this.availability) === 'openrouter' && this.openrouter)
      return this.openrouter.chat(m.openrouterModelId!);
    const provider = providerIdOf(m.provider);
    if (provider === 'openai' && this.openai) return this.openai(m.providerModelId);
    if (provider === 'anthropic' && this.anthropic) return this.anthropic(m.providerModelId);
    throw new Error(`No provider configured for model "${m.key}" (${m.provider})`);
  }

  imageModel(m: ModelInfo): ImageModel {
    if (this.availability.demo) return new DemoImageModel(m.key, this.demoImageDelayMs);
    // OpenRouter's images endpoint: Gemini image, FLUX, Seedream, GPT Image… with the one key.
    if (routeOf(m, this.availability) === 'openrouter' && this.openrouter)
      return this.openrouter.imageModel(m.openrouterModelId!);
    if (providerIdOf(m.provider) === 'openai' && this.openai) return this.openai.image(m.providerModelId);
    throw new Error(`No provider configured for image model "${m.key}" (${m.provider})`);
  }

  /** A small model that can look at images (to read attached pictures), or null without a key. */
  visionModel(): LanguageModel | null {
    if (this.availability.demo) return null;
    if (this.openai) return this.openai('gpt-4o-mini');
    return null;
  }

  /**
   * Speech to text for voice typing (OpenAI's transcription model), or null when no key is set.
   * gpt-4o-mini-transcribe handles mixed languages (e.g. English and Urdu) and costs little per minute.
   */
  transcriptionModel(): TranscriptionModel | null {
    if (this.availability.demo) return new DemoTranscriptionModel();
    if (this.openai) return this.openai.transcription('gpt-4o-mini-transcribe');
    return null;
  }

  /** Can this image model edit or vary an existing image (image input, and a mask for edits)? */
  takesImageInput(m: ModelInfo): boolean {
    // The stand-in follows the same rule, so the menus match production. Through OpenRouter
    // there are no masks, so editing and variations stay with OpenAI's own key for now.
    if (!this.availability.demo && routeOf(m, this.availability) === 'openrouter') return false;
    return providerIdOf(m.provider) === 'openai';
  }

  /** OpenAI image models take a fixed set of sizes; OpenRouter takes an aspect ratio and a size tier. */
  imageCall(m: ModelInfo, ratio: ImageRatio, hd: boolean): ImageCall {
    if (this.availability.demo) return { aspectRatio: ratio };
    if (routeOf(m, this.availability) === 'openrouter')
      return { aspectRatio: ratio, providerOptions: hd ? { openrouter: { resolution: '2K' } } : undefined };
    if (providerIdOf(m.provider) === 'openai') {
      const size = ratio === '1:1' ? '1024x1024' : ratio === '9:16' ? '1024x1536' : '1536x1024';
      return { size, providerOptions: { openai: { quality: hd ? 'high' : 'medium' } } };
    }
    return { aspectRatio: ratio };
  }

  /** Stand-in image speed (slower in the demo backend so progress can be seen). */
  demoImageDelayMs = 400;
}

/** Shape and quality as each provider expects them. */
export interface ImageCall {
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
  providerOptions?: Record<string, Record<string, string>>;
}

export const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:2'] as const;
export type ImageRatio = (typeof IMAGE_RATIOS)[number];

/** Demo mode is on when asked for, or by default outside production when no provider key is set. */
export function demoEnabled(env: { NODE_ENV: string; AI_DEMO?: boolean }, keys: ProviderKeys): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (env.AI_DEMO !== undefined) return env.AI_DEMO;
  return !keys.openai && !keys.anthropic && !keys.openrouter;
}
