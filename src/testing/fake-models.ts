import type { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import type { Env } from '../config/env.js';
import type { AiModel } from '../database/schemas/ai-model.schema.js';
import type { ModelInfo } from '../models/models.logic.js';
import { MODEL_SEED } from '../models/registry.seed.js';
import { ModelsService } from '../models/models.service.js';

/** Registry rows as `pnpm seed` writes them, optionally overridden per key. */
export function seedRows(overrides: Record<string, Partial<ModelInfo>> = {}): ModelInfo[] {
  return MODEL_SEED.map((m) => ({
    ...m,
    providerModelId: '',
    status: 'hidden' as const,
    inputPriceMicros: 0,
    outputPriceMicros: 0,
    ...overrides[m.key],
  }));
}

/** A ModelsService over in-memory rows, without a database. */
export function modelsService(rows: ModelInfo[], env: Partial<Env> = {}): ModelsService {
  const fakeModel = {
    find: () => ({ sort: () => ({ lean: async () => rows.filter((r) => r.status !== 'paused') }) }),
  } as unknown as Model<AiModel>;
  const values: Partial<Env> = { NODE_ENV: 'test', ...env };
  const config = { get: (k: keyof Env) => values[k] } as unknown as ConfigService<Env, true>;
  return new ModelsService(fakeModel, config);
}
