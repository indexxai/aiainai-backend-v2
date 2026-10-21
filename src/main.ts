import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { Auth } from './auth/auth.factory.js';
import { AUTH } from './auth/auth.tokens.js';
import type { Env } from './config/env.js';
import { buildOpenApi, configureApp } from './setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(PinoLogger));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  configureApp(app, app.get<Auth>(AUTH), {
    appUrl: config.get('APP_URL', { infer: true }),
    businessSpace: config.get('BUSINESS_SPACE', { infer: true }) === 'on',
  });
  // Only the web app's origin may call the API from a browser.
  app.enableCors({
    origin: config.get('APP_URL', { infer: true }),
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  const docsOn =
    config.get('API_DOCS', { infer: true }) ?? config.get('NODE_ENV', { infer: true }) !== 'production';
  // Not /api/docs: that is the Documents API, and Swagger there answers GET /api/docs itself.
  if (docsOn) SwaggerModule.setup('api/swagger', app, buildOpenApi(app));

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`API listening on :${port}${docsOn ? ' — API reference at /api/swagger' : ''}`, 'Bootstrap');
}
await bootstrap();
