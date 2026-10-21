import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import type { Connection } from 'mongoose';
import type { Env } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { createAuth } from './auth.factory.js';
import { AuthGuard } from './auth.guard.js';
import { AUTH } from './auth.tokens.js';

const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me';

@Global()
@Module({
  imports: [WorkspacesModule],
  providers: [
    {
      provide: AUTH,
      inject: [ConfigService, getConnectionToken(), EmailService, WorkspacesService],
      useFactory: (
        config: ConfigService<Env, true>,
        connection: Connection,
        email: EmailService,
        workspaces: WorkspacesService,
      ) => {
        const production = config.get('NODE_ENV', { infer: true }) === 'production';
        const secret = config.get('BETTER_AUTH_SECRET', { infer: true });
        if (!secret)
          new Logger('Auth').warn('BETTER_AUTH_SECRET is not set; using a development-only secret.');
        const gid = config.get('GOOGLE_CLIENT_ID', { infer: true });
        const gsecret = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
        const client = connection.getClient();
        return createAuth({
          database: mongodbAdapter(client.db(config.get('MONGODB_DB', { infer: true })), { client }),
          appUrl: config.get('APP_URL', { infer: true }),
          secret: secret ?? DEV_SECRET,
          production,
          verifyEmail: config.get('EMAIL_VERIFICATION', { infer: true }) === 'on',
          google: gid && gsecret ? { clientId: gid, clientSecret: gsecret } : undefined,
          sendCode: (to, code, kind) => email.sendCode(to, code, kind),
          onUserCreated: async (user) => {
            await workspaces.ensureForUser(user);
          },
        });
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
