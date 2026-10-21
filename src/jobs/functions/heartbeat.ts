import type { INestApplicationContext } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { inngest } from '../inngest.client.js';

/**
 * Smoke-test job: proves the worker receives events, runs steps and reaches MongoDB
 * through Nest's dependency injection. Send `system/heartbeat` from the Inngest dashboard.
 */
export const createHeartbeat = (ctx: INestApplicationContext) =>
  inngest.createFunction(
    { id: 'system-heartbeat', triggers: [{ event: 'system/heartbeat' }] },
    async ({ step }) => {
      const dbMs = await step.run('ping database', async () => {
        const conn = ctx.get<Connection>(getConnectionToken());
        await conn.asPromise();
        const started = Date.now();
        await conn.db?.admin().ping();
        return Date.now() - started;
      });
      return { ok: true, dbMs };
    },
  );
