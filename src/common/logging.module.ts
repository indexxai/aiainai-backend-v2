import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { REQUEST_ID_HEADER, requestIdFor } from './request-id.js';

/**
 * Structured JSON logs (one line per request, with request ID, status and duration).
 * Readable, coloured output in development. Secrets and cookies are never logged.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const dev = config.get('NODE_ENV', { infer: true }) === 'development';
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const id = requestIdFor(req);
              res.setHeader(REQUEST_ID_HEADER, id);
              return id;
            },
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
              censor: '[redacted]',
            },
            // Health checks run every few seconds; keep them out of the logs.
            autoLogging: { ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/api/health') },
            transport: dev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggingModule {}
