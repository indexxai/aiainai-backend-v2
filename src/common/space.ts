import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SPACE_KINDS, type SpaceKind } from '../database/schemas/workspace.schema.js';

/** The web app sends the space the person is in on every request (header, else cookie). */
export const SPACE_HEADER = 'x-aiainai-space';
export const SPACE_COOKIE = 'aiainai_space';

const store = new AsyncLocalStorage<{ space: SpaceKind }>();

const isSpace = (v: unknown): v is SpaceKind => SPACE_KINDS.includes(v as SpaceKind);

export function spaceFromRequest(req: IncomingMessage): SpaceKind {
  const header = req.headers[SPACE_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (isSpace(value)) return value;
  const cookie = req.headers.cookie
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === SPACE_COOKIE)?.[1];
  return isSpace(cookie) ? cookie : 'personal';
}

/**
 * Remembers the requested space for the rest of the request, so `WorkspacesService.forRequest`
 * can pick the Personal or Business workspace without every endpoint passing it along.
 * Anything unrecognised means Personal.
 */
export function spaceMiddleware(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
  store.run({ space: spaceFromRequest(req) }, next);
}

let businessOpen = true;
/** Whether the Business space (Captain Jack) has launched; set once at start-up. */
export const isBusinessOpen = () => businessOpen;
export function setBusinessOpen(open: boolean): void {
  businessOpen = open;
}

/** While the Business space hasn't launched, every request is served from Personal. */
export function personalOnlyMiddleware(_req: IncomingMessage, _res: ServerResponse, next: () => void): void {
  store.run({ space: 'personal' }, next);
}

/** The space this request asked for ("personal" outside a request, e.g. in the worker). */
export function requestedSpace(): SpaceKind {
  return store.getStore()?.space ?? 'personal';
}

/** For tests and background work: run `fn` as if the request asked for `space`. */
export function inSpace<T>(space: SpaceKind, fn: () => T): T {
  return store.run({ space }, fn);
}
