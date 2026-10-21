import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AiModel } from './database/schemas/ai-model.schema.js';
import { MODEL_SEED } from './models/registry.seed.js';
import { WorkerModule } from './worker.module.js';

/**
 * Prepares a fresh database: builds indexes and adds the starting model registry.
 * Safe to run again: existing models are left as they are (Admin edits win).
 * Usage: `pnpm seed` (uses MONGODB_URI / MONGODB_DB).
 */
const ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
const conn = ctx.get<Model<AiModel>>(getModelToken(AiModel.name)).db;

for (const name of Object.keys(conn.models)) {
  await conn.models[name]!.syncIndexes();
}

const models = ctx.get<Model<AiModel>>(getModelToken(AiModel.name));
let added = 0;
for (const m of MODEL_SEED) {
  const res = await models.updateOne(
    { key: m.key },
    { $setOnInsert: { ...m, providerModelId: '', status: 'hidden' } },
    { upsert: true },
  );
  added += res.upsertedCount;
}
console.log(
  `Indexes synced for ${Object.keys(conn.models).length} collections; ${added} model(s) added to the registry.`,
);
await ctx.close();
process.exit(0);
