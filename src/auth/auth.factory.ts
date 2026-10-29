import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { passwordProblems } from './password-policy.js';

export interface AuthDeps {
  /** Better Auth storage: the MongoDB adapter in the app, the memory adapter in tests. */
  database: BetterAuthOptions['database'];
  /** Public URL of the web app. Auth routes are reached through it at /api/auth. */
  appUrl: string;
  /** Other browser origins allowed to call auth (for example, the staging web app). */
  trustedOrigins?: string[];
  secret: string;
  production: boolean;
  /**
   * Ask new email sign-ups for a 6-digit code before they can sign in. Off until an email
   * service is set up (EMAIL_VERIFICATION=on turns it back on); then sign-up signs in at once.
   */
  verifyEmail?: boolean;
  google?: { clientId: string; clientSecret: string };
  sendCode: (
    email: string,
    code: string,
    kind: 'email-verification' | 'forget-password' | 'sign-in' | 'change-email',
  ) => Promise<void>;
  /** Runs once for every new user (email or Google): creates their workspace and credits. */
  onUserCreated: (user: { id: string; name: string; email: string }) => Promise<void>;
}

export const SESSION_DAYS = 30;

/**
 * Sign-in for aiainai (Better Auth).
 * - Email + password sign-up, confirmed with a 6-digit email code before first sign-in
 * - Google sign-in (when keys are set); a Google login with the same verified email links to the account
 * - Password reset by email code
 * - Sessions in a first-party cookie on the web app's domain, 30 days ("Keep me signed in")
 * Users, sessions, sign-in methods and codes live in Better Auth's collections
 * (user, session, account, verification).
 */
export function createAuth(deps: AuthDeps) {
  const verifyEmail = deps.verifyEmail !== false;
  return betterAuth({
    appName: 'aiainai',
    baseURL: deps.appUrl,
    basePath: '/api/auth',
    secret: deps.secret,
    trustedOrigins: [...new Set([deps.appUrl, ...(deps.trustedOrigins ?? [])])],
    database: deps.database,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: verifyEmail,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    emailVerification: {
      sendOnSignUp: verifyEmail,
      autoSignInAfterVerification: true,
    },
    socialProviders: deps.google
      ? {
          google: {
            clientId: deps.google.clientId,
            clientSecret: deps.google.clientSecret,
            prompt: 'select_account',
          },
        }
      : undefined,
    account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
    session: { expiresIn: SESSION_DAYS * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    rateLimit: { enabled: true, window: 60, max: 30 },
    advanced: { cookiePrefix: 'aiainai', useSecureCookies: deps.production },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        overrideDefaultEmailVerification: true,
        sendVerificationOnSignUp: verifyEmail,
        // Not awaited, so response time doesn't reveal whether an email exists.
        sendVerificationOTP: async ({ email, otp, type }) => {
          void deps.sendCode(email, otp, type).catch(() => undefined);
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email' && ctx.path !== '/email-otp/reset-password') return;
        const body = ctx.body as { password?: unknown; email?: unknown; name?: unknown } | undefined;
        if (ctx.path === '/sign-up/email') {
          const name = typeof body?.name === 'string' ? body.name.trim() : '';
          if (!name || name.length > 100) {
            throw new APIError('BAD_REQUEST', {
              code: 'NAME_REQUIRED',
              message: 'Enter a name of 1 to 100 characters',
            });
          }
        }
        // Enforce the password rules wherever a password is set.
        const pw = body?.password;
        if (typeof pw === 'string') {
          const missing = passwordProblems(pw);
          if (missing.length) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_TOO_WEAK',
              message: `Password needs: ${missing.join(', ')}`,
            });
          }
        }
        // Sign-up with an email that already has an account. Better Auth would answer with a
        // made-up user and send no code, leaving people waiting on the code screen. Say so instead:
        // a confirmed account is told to sign in; an unconfirmed one is sent back to its code.
        if (ctx.path === '/sign-up/email' && typeof body?.email === 'string') {
          const found = await ctx.context.internalAdapter.findUserByEmail(body.email.trim().toLowerCase());
          if (found?.user) {
            if (found.user.emailVerified || !verifyEmail) {
              throw new APIError('UNPROCESSABLE_ENTITY', {
                code: 'USER_ALREADY_EXISTS',
                message: 'An account with this email already exists',
              });
            }
            throw new APIError('FORBIDDEN', {
              code: 'EMAIL_NOT_VERIFIED',
              message: 'This email has an account that is not confirmed yet',
            });
          }
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await deps.onUserCreated({ id: user.id, name: user.name, email: user.email });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
