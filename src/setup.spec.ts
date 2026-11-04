import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { sameOriginOnly } from './setup.js';

function run(guard: ReturnType<typeof sameOriginOnly>, method: string, origin?: string) {
  const next = vi.fn() as unknown as NextFunction;
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
  guard({ method, headers: origin ? { origin } : {} } as Request, res, next);
  return { passed: (next as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1, res };
}

describe('sameOriginOnly', () => {
  const guard = sameOriginOnly('https://jackai.si', ['https://test.jackai.si']);

  it('accepts changes from the app and from trusted origins', () => {
    expect(run(guard, 'POST', 'https://jackai.si').passed).toBe(true);
    expect(run(guard, 'POST', 'https://test.jackai.si').passed).toBe(true);
  });

  it('refuses changes from any other site', () => {
    const { passed, res } = run(guard, 'POST', 'https://evil.example');
    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('lets reads and requests without an Origin through', () => {
    expect(run(guard, 'GET', 'https://evil.example').passed).toBe(true);
    expect(run(guard, 'POST').passed).toBe(true);
  });

  it('accepts only the app when no trusted origins are set', () => {
    const appOnly = sameOriginOnly('https://jackai.si');
    expect(run(appOnly, 'POST', 'https://jackai.si').passed).toBe(true);
    expect(run(appOnly, 'POST', 'https://test.jackai.si').passed).toBe(false);
  });
});
