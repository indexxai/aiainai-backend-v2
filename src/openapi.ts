import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';

/**
 * Writes openapi.json — the contract the frontend generates its typed API client from.
 * Run `pnpm openapi` after changing any endpoint and commit the file.
 */
// No database is needed to describe the API; config is validated when the modules load,
// so set a placeholder before importing them.
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/openapi-export';
process.env.DB_LAZY_CONNECT = '1';
const { AppModule } = await import('./app.module.js');
const { buildOpenApi, configureApp } = await import('./setup.js');
const app = await NestFactory.create<import('@nestjs/platform-express').NestExpressApplication>(AppModule, {
  logger: ['error'],
  bodyParser: false,
});
configureApp(app);
await app.init();
const doc = buildOpenApi(app);
writeFileSync('openapi.json', JSON.stringify(doc, null, 2) + '\n');
await app.close();
console.log(`openapi.json written (${Object.keys(doc.paths).length} paths)`);
process.exit(0);
