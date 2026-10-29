import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuth } from './auth.factory.js';

/**
 * The real sign-up / verify / sign-in flow, run against Better Auth with an in-memory store.
 */
let n = 0;
function setup(verifyEmail = true, trustedOrigins: string[] = []) {
  // Each test is its own visitor, so sign-up rate limits don't carry over between tests.
  const ip = `10.0.0.${++n}`;
  const codes: Record<string, string> = {};
  const created: string[] = [];
  const auth = createAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    appUrl: 'http://localhost:3000',
    trustedOrigins,
    secret: 'test-secret-test-secret-test-secret-1234',
    production: false,
    verifyEmail,
    sendCode: async (email, code) => {
      codes[email] = code;
    },
    onUserCreated: async (u) => {
      created.push(u.email);
    },
  });
  const call = (path: string, body?: unknown, cookie?: string, origin = 'http://localhost:3000') =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'x-forwarded-for': ip,
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { auth, call, codes, created };
}

const cookieFrom = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

describe('sign-up and sign-in', () => {
  it('accepts a sign-in request from an explicitly trusted test origin', async () => {
    const { call } = setup(true, ['https://test.jackai.si']);
    const res = await call(
      '/sign-in/email',
      { email: 'nobody@example.com', password: 'whatever-123' },
      undefined,
      'https://test.jackai.si',
    );
    // The credentials are rejected, rather than the origin.
    expect(res.status).toBe(401);
  });

  it('signs up, verifies with the emailed code, then signs in', async () => {
    const { call, codes, created } = setup();
    const email = 'sara@example.com';

    const signUp = await call('/sign-up/email', { name: 'Sara', email, password: 'correct-horse-9' });
    expect(signUp.status).toBe(200);
    expect(created).toEqual([email]);
    await new Promise((r) => setTimeout(r, 10)); // code is sent without awaiting
    expect(codes[email]).toMatch(/^\d{6}$/);

    // Unverified accounts can't sign in yet.
    const early = await call('/sign-in/email', { email, password: 'correct-horse-9' });
    expect(early.status).toBe(403);

    const wrong = await call('/email-otp/verify-email', {
      email,
      otp: '000000' === codes[email] ? '111111' : '000000',
    });
    expect(wrong.status).toBe(400);

    const verify = await call('/email-otp/verify-email', { email, otp: codes[email] });
    expect(verify.status).toBe(200);

    const signIn = await call('/sign-in/email', { email, password: 'correct-horse-9', rememberMe: true });
    expect(signIn.status).toBe(200);
    const session = await call('/get-session', undefined, cookieFrom(signIn));
    const body = (await session.json()) as { user: { email: string; emailVerified: boolean } };
    expect(body.user).toMatchObject({ email, emailVerified: true });
  });

  it('rejects a wrong password without saying whether the email exists', async () => {
    const { call } = setup();
    const a = await call('/sign-in/email', { email: 'nobody@example.com', password: 'whatever-123' });
    expect(a.status).toBe(401);
  });

  it('requires a letter and a number or symbol', async () => {
    const { call } = setup();
    const res = await call('/sign-up/email', {
      name: 'Al',
      email: 'al@example.com',
      password: 'onlyletters',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('PASSWORD_TOO_WEAK');
  });

  it('requires passwords of at least 8 characters', async () => {
    const { call } = setup();
    const res = await call('/sign-up/email', { name: 'Al', email: 'al@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('tells a confirmed account to sign in instead of signing up again', async () => {
    const { call, codes, created } = setup();
    const email = 'dup@example.com';
    await call('/sign-up/email', { name: 'Dup', email, password: 'correct-horse-9' });
    await new Promise((r) => setTimeout(r, 10));
    await call('/email-otp/verify-email', { email, otp: codes[email] });

    const again = await call('/sign-up/email', {
      name: 'Dup',
      email: 'DUP@example.com ',
      password: 'other-pass-9',
    });
    expect(again.status).toBe(422);
    expect(((await again.json()) as { code: string }).code).toBe('USER_ALREADY_EXISTS');
    expect(created).toEqual([email]);
  });

  it('sends an unconfirmed account back to its code instead of faking a new sign-up', async () => {
    const { call, created } = setup();
    const email = 'later@example.com';
    await call('/sign-up/email', { name: 'Later', email, password: 'correct-horse-9' });
    const again = await call('/sign-up/email', { name: 'Later', email, password: 'correct-horse-9' });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
    expect(created).toEqual([email]);
  });

  it('requires a name', async () => {
    const { call, created } = setup();
    for (const name of ['', '   ', 'x'.repeat(101)]) {
      const res = await call('/sign-up/email', {
        name,
        email: 'noname@example.com',
        password: 'correct-horse-9',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('NAME_REQUIRED');
    }
    expect(created).toEqual([]);
  });
});

describe('sign-up with email codes off (no email service yet)', () => {
  it('signs in straight after sign-up, sends no code, and signs in again later', async () => {
    const { call, codes, created } = setup(false);
    const email = 'nocode@example.com';
    const signUp = await call('/sign-up/email', { name: 'Ali', email, password: 'correct-horse-9' });
    expect(signUp.status).toBe(200);
    expect(((await signUp.json()) as { token: string | null }).token).toBeTruthy();
    const cookie = cookieFrom(signUp);
    const session = (await (await call('/get-session', undefined, cookie)).json()) as {
      user: { email: string };
    };
    expect(session.user.email).toBe(email);
    expect(created).toEqual([email]);
    await new Promise((r) => setTimeout(r, 10));
    expect(codes[email]).toBeUndefined();

    expect((await call('/sign-in/email', { email, password: 'correct-horse-9' })).status).toBe(200);
    // Signing up again with the same email is told to sign in.
    const again = await call('/sign-up/email', { name: 'Ali', email, password: 'correct-horse-9' });
    expect(again.status).toBe(422);
  });
});
