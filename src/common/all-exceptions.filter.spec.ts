import { BadRequestException, HttpStatus, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { AppError } from './api-error.js';

function run(exception: unknown) {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    getHeader: () => undefined,
    status(s: number) {
      out.status = s;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-123' }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return out;
}

describe('AllExceptionsFilter', () => {
  it('maps Nest HTTP errors to the standard shape', () => {
    const out = run(new NotFoundException('Chat not found'));
    expect(out.status).toBe(404);
    expect(out.body).toEqual({
      error: { code: 'not_found', message: 'Chat not found', requestId: 'req-123' },
    });
  });

  it('keeps app-specific codes', () => {
    const out = run(
      new AppError('insufficient_credits', 'You need 4 more credits.', HttpStatus.PAYMENT_REQUIRED),
    );
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({
      error: { code: 'insufficient_credits', message: 'You need 4 more credits.' },
    });
  });

  it('never leaks internal details of unexpected errors', () => {
    const out = run(new Error('connect ECONNREFUSED 10.0.0.5:27017'));
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain('10.0.0.5');
    expect(out.body).toMatchObject({ error: { code: 'internal_error', requestId: 'req-123' } });
  });

  it('lists validation problems', () => {
    const out = run(new BadRequestException(['email must be an email']));
    expect(out.body).toMatchObject({
      error: { code: 'validation_failed', details: { problems: ['email must be an email'] } },
    });
  });
});
