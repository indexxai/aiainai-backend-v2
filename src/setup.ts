import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import { raw, type NextFunction, type Request, type Response } from 'express';
import type { Auth } from './auth/auth.factory.js';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import helmet from 'helmet';
import { ApiErrorBody, ApiErrorResponse } from './common/api-error.js';
import { personalOnlyMiddleware, setBusinessOpen, spaceMiddleware } from './common/space.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request guard for the cookie-authenticated API. Browsers send an Origin header on
 * every cross-site (and same-site non-GET) request, so a mismatched Origin on a change is refused.
 * Requests without an Origin (server-to-server, curl) carry no browser cookies by accident.
 */
export function sameOriginOnly(appUrl: string) {
  const allowed = new URL(appUrl).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (SAFE_METHODS.has(req.method) || !origin || origin === allowed) return next();
    res.status(403).json({
      error: { code: 'forbidden', message: 'This request came from another site.', requestId: 'unknown' },
    });
  };
}

/** Shared HTTP setup used by main.ts, the OpenAPI export and e2e tests. */
export function configureApp(
  app: NestExpressApplication,
  auth?: Auth,
  opts: { appUrl?: string; businessSpace?: boolean } = {},
): void {
  app.setGlobalPrefix('api');
  app.use(helmet());
  // Better Auth reads the raw request body itself, so it is mounted before the JSON parser.
  if (auth) app.use('/api/auth', toNodeHandler(auth));
  // Personal or Business: read once per request (see WorkspacesService.forRequest).
  // Until Captain Jack launches, everything is Personal and Business can't be set up.
  setBusinessOpen(opts.businessSpace !== false);
  if (opts.businessSpace === false) {
    app.use(personalOnlyMiddleware);
    app.use('/api/spaces/business', (_req: Request, res: Response) => {
      res.status(403).json({
        error: { code: 'forbidden', message: 'Captain Jack is coming soon.', requestId: 'unknown' },
      });
    });
  } else app.use(spaceMiddleware);
  if (opts.appUrl) app.use('/api', sameOriginOnly(opts.appUrl));
  // Documents may hold up to 2,000,000 characters, so a full save can be a few MB of JSON.
  // Only JSON is accepted: no form posts, so a plain HTML form on another site can't call the API.
  // Stripe signs the exact bytes it sends, so its webhook gets the raw body (the JSON parser
  // then skips it).
  app.use('/api/billing/stripe/webhook', raw({ type: 'application/json', limit: '1mb' }));
  app.useBodyParser('json', { limit: '6mb' });
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('aiainai API')
    .setDescription('Backend for aiainai (AI Station). The web app calls these endpoints through /api.')
    .setVersion('0.1.0')
    .build();
  // Error shapes are always in the contract so the frontend can type error handling.
  return SwaggerModule.createDocument(app, config, { extraModels: [ApiErrorResponse, ApiErrorBody] });
}
