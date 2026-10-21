import type { INestApplicationContext } from '@nestjs/common';
import { createHeartbeat } from './heartbeat.js';

/** Every background function the worker serves. Functions get Nest services from `ctx`. */
export const createFunctions = (ctx: INestApplicationContext) => [createHeartbeat(ctx)];
