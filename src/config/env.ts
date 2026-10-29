import { z } from 'zod';

/** Empty values (e.g. `OPENAI_API_KEY=` copied from .env.example) count as not set. */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

/**
 * Every environment variable the backend reads, validated at startup so a missing secret
 * stops the app immediately instead of breaking a feature later. Keep in sync with .env.example.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  WORKER_PORT: z.coerce.number().int().positive().default(4001),
  /**
   * The Business space (Captain Jack). Off until it launches: every request is served from
   * Personal and setting up a Business space is refused.
   */
  BUSINESS_SPACE: z.enum(['on', 'off']).default('off'),
  EMAIL_VERIFICATION: z.enum(['on', 'off']).default('off'),
  /** Public URL of the web app; used for CORS and links in emails. */
  // A trailing slash would break CORS (browsers send the origin without one) and double up in links.
  APP_URL: z
    .url()
    .default('http://localhost:3000')
    .transform((v) => v.replace(/\/+$/, '')),
  /** Additional browser origins permitted to call the auth API (comma-separated). */
  TRUSTED_ORIGINS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value?.trim()) return [];
      const origins = value
        .split(',')
        .map((origin) => origin.trim().replace(/\/+$/, ''))
        .filter(Boolean);
      for (const origin of origins) {
        try {
          if (new URL(origin).origin !== origin) throw new Error();
        } catch {
          ctx.addIssue({ code: 'custom', message: `must contain only origins; received ${origin}` });
        }
      }
      return [...new Set(origins)];
    }),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DB: z.string().default('aiainai'),
  /** Signs session cookies. Required in production (32+ random characters). */
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Email delivery. Without a key, codes are written to the server log (development only). */
  RESEND_API_KEY: z.string().optional(),
  // An empty `EMAIL_FROM=` line falls back to the default too.
  EMAIL_FROM: optionalSecret.transform((v) => v ?? 'aiainai <hello@aiainai.ai>'),
  /** Model providers. A model is offered only when its provider has a key (see `pnpm models:configure`). */
  OPENAI_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  /** OpenRouter: one key for every model maker. Models with an OpenRouter id are called through it. */
  OPENROUTER_API_KEY: optionalSecret,
  /**
   * App connections (Gmail, Google Calendar, Google Drive, Slack) through Composio. Each app also needs its auth
   * config id from the Composio dashboard. Without a key, a stand-in connector is used outside
   * production and connecting is turned off in production.
   */
  COMPOSIO_API_KEY: optionalSecret,
  COMPOSIO_AUTH_CONFIG_GMAIL: optionalSecret,
  COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR: optionalSecret,
  COMPOSIO_AUTH_CONFIG_GOOGLE_DRIVE: optionalSecret,
  COMPOSIO_AUTH_CONFIG_SLACK: optionalSecret,
  /**
   * Jack's browser (v2): Browserbase hosted browsers with a live view. Without both values, a
   * sample browser is used outside production and the browser tool is off in production.
   */
  BROWSERBASE_API_KEY: optionalSecret,
  BROWSERBASE_PROJECT_ID: optionalSecret,
  /** Sample browser pace (tests use a few milliseconds). */
  BROWSER_SAMPLE_STEP_MS: z.coerce.number().int().min(0).optional(),
  /**
   * Payments (Stripe Checkout, one-time). Secret key from Developers → API keys; webhook secret
   * from the webhook endpoint for /api/billing/stripe/webhook. Without a key, a sample checkout
   * that always succeeds is used outside production and payments are off in production.
   */
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  /** Upscale and Remove background in AI Image (Stability AI). Without it those two tools are hidden. */
  STABILITY_API_KEY: optionalSecret,
  STABILITY_UPSCALE_PATH: z.string().startsWith('/').optional(),
  STABILITY_CUTOUT_PATH: z.string().startsWith('/').optional(),
  /**
   * Stand-in model that streams sample answers, for building and testing without provider keys.
   * Default: on outside production when no provider key is set. Never allowed in production.
   */
  AI_DEMO: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Where generated images and uploads are stored. `gridfs` keeps them in MongoDB (works on Atlas
   * with no extra service); `s3` (any S3-compatible store) is added when the hosting team picks one.
   */
  STORAGE_DRIVER: z.enum(['gridfs', 'memory']).default('gridfs'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Swagger UI at /api/swagger. On by default outside production. */
  API_DOCS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema
    .superRefine((env, ctx) => {
      if (env.NODE_ENV !== 'production') return;
      if (!env.BETTER_AUTH_SECRET)
        ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_SECRET'], message: 'required in production' });
      if (!env.RESEND_API_KEY)
        ctx.addIssue({
          code: 'custom',
          path: ['RESEND_API_KEY'],
          message: 'required in production (sign-up codes are emailed)',
        });
      if (env.AI_DEMO)
        ctx.addIssue({
          code: 'custom',
          path: ['AI_DEMO'],
          message: 'the stand-in model cannot run in production',
        });
    })
    .safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
