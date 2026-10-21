import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AiModel } from './database/schemas/ai-model.schema.js';
import { WorkerModule } from './worker.module.js';

/**
 * Turns models on once a provider account is ready. Provider model ids are never guessed in
 * code: whoever owns the provider account sets them here (or in Admin, later).
 *
 *   pnpm models:configure                         list the registry
 *   pnpm models:configure gpt=<openai model id>   set the provider model id and make it live
 *   pnpm models:configure qwen.openrouter=<id>     set its OpenRouter id (used when OPENROUTER_API_KEY is set)
 *   pnpm models:configure qwen.openrouter=off      stop routing it through OpenRouter
 *   pnpm models:configure gpt.price=2.5/10        provider price, USD per million tokens (input/output)
 *   pnpm models:configure gpt=off                 hide it from the menus again
 *   pnpm models:configure gpt=pause               keep it listed in Admin, refuse new calls
 */
const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
const models = ctx.get<Model<AiModel>>(getModelToken(AiModel.name));
const args = process.argv.slice(2);
let failed = false;

for (const arg of args) {
  const m = /^([a-z0-9-]+)(\.price|\.openrouter)?=(.+)$/.exec(arg);
  if (!m) {
    console.error(
      `Skipped "${arg}": expected key=<provider model id>, key.openrouter=<id>, key=off, key=pause or key.price=IN/OUT`,
    );
    failed = true;
    continue;
  }
  const [, key, field, value] = m as unknown as [string, string, string | undefined, string];
  const price = field === '.price';
  let update: Partial<AiModel>;
  if (field === '.openrouter') {
    update = value === 'off' ? { openrouterModelId: '' } : { openrouterModelId: value, status: 'live' };
  } else if (price) {
    const [inp, out] = value.split('/').map(Number);
    if (!Number.isFinite(inp) || !Number.isFinite(out) || inp! < 0 || out! < 0) {
      console.error(`Skipped "${arg}": price must look like 2.5/10 (USD per million tokens)`);
      failed = true;
      continue;
    }
    update = { inputPriceMicros: Math.round(inp! * 1e6), outputPriceMicros: Math.round(out! * 1e6) };
  } else if (value === 'off') update = { status: 'hidden' };
  else if (value === 'pause') update = { status: 'paused' };
  else update = { providerModelId: value, status: 'live' };
  const res = await models.updateOne({ key }, { $set: update });
  if (!res.matchedCount) {
    console.error(`Skipped "${arg}": no model with key "${key}" (run pnpm seed first?)`);
    failed = true;
  }
}

const rows = await models.find().sort({ kind: 1, sortOrder: 1 }).lean();
console.table(
  rows.map((r) => ({
    key: r.key,
    kind: r.kind,
    provider: r.provider,
    providerModelId: r.providerModelId || '—',
    openrouter: r.openrouterModelId || '—',
    status: r.status,
    credits: r.credits,
    plans: r.plans.join('+'),
    'price in/out ($/M)':
      r.inputPriceMicros || r.outputPriceMicros
        ? `${r.inputPriceMicros / 1e6}/${r.outputPriceMicros / 1e6}`
        : '—',
  })),
);
await ctx.close();
process.exit(failed ? 1 : 0);
