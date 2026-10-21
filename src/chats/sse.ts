import type { Request, Response } from 'express';
import { liveRuns } from '../common/live-runs.js';
import { REQUEST_ID_HEADER } from '../common/request-id.js';

export interface SseEvent {
  event: string;
  data: unknown;
}

const HEARTBEAT_MS = 15_000;

/** The request ID pino-http assigned (also on the response header). */
export function requestIdOf(req: Request, res: Response): string | undefined {
  const id = (req as Request & { id?: unknown }).id ?? res.getHeader(REQUEST_ID_HEADER);
  return id ? String(id) : undefined;
}

/**
 * Sends events as text/event-stream. The run keeps going if the browser goes away (closed tab,
 * another page): events are drained and the result is saved. Stop is a separate call that
 * aborts the run registered under `key` (see live-runs.ts).
 */
export async function sendSse(
  req: Request,
  res: Response,
  key: string,
  produce: (signal: AbortSignal) => AsyncIterable<SseEvent>,
): Promise<void> {
  const run = liveRuns.start(key);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: don't buffer
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  try {
    for await (const e of produce(run.signal)) {
      if (res.writableEnded || res.destroyed) continue; // the page left: keep going so it's saved
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    }
  } finally {
    liveRuns.end(key, run);
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    void req;
  }
}
