import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Reuse the caller's request ID (e.g. from the load balancer or the web app) when it is a
 * sane value; otherwise make a new one. Every log line and error response carries it.
 */
export function requestIdFor(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && SAFE_ID.test(value) ? value : randomUUID();
}
