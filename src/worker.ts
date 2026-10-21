import 'reflect-metadata';
import http from 'node:http';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { serve } from 'inngest/node';
import type { Env } from './config/env.js';
import { createFunctions } from './jobs/functions/index.js';
import { inngest } from './jobs/inngest.client.js';
import { WorkerModule } from './worker.module.js';

/**
 * Background worker process. Inngest calls POST /api/inngest to run functions;
 * GET /health is for the host's health checks.
 */
async function bootstrap() {
  const ctx = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  ctx.useLogger(ctx.get(PinoLogger));
  ctx.enableShutdownHooks();
  const port = ctx.get<ConfigService<Env, true>>(ConfigService).get('WORKER_PORT', { infer: true });
  const functions = createFunctions(ctx);
  const handler = serve({ client: inngest, functions });

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/api/inngest') return void handler(req, res);
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ ok: true, functions: functions.length }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () =>
    Logger.log(`Worker listening on :${port} — ${functions.length} function(s)`, 'Worker'),
  );
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => server.close(() => void ctx.close().then(() => process.exit(0))));
  }
}
await bootstrap();
