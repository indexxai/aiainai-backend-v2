import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { HealthController } from './health.controller.js';

function fakeRes() {
  const res = { statusCode: 0, headers: {} as Record<string, string> };
  return Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
      return this;
    },
  }) as unknown as Response & typeof res;
}

const conn = (ping: () => Promise<unknown>) =>
  ({ asPromise: async () => undefined, db: { admin: () => ({ ping }) } }) as unknown as Connection;

describe('HealthController', () => {
  it('returns 200 when the database answers', async () => {
    const res = fakeRes();
    const report = await new HealthController(conn(async () => ({ ok: 1 }))).check(res);
    expect(res.statusCode).toBe(200);
    expect(report.ok).toBe(true);
    expect(report.checks.database?.ok).toBe(true);
  });

  it('returns 503 with a generic message when the database is down', async () => {
    const res = fakeRes();
    const report = await new HealthController(
      conn(async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:27017');
      }),
    ).check(res);
    expect(res.statusCode).toBe(503);
    expect(report.checks.database).toEqual({ ok: false, error: 'unreachable' });
    expect(JSON.stringify(report)).not.toContain('10.0.0.5');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
