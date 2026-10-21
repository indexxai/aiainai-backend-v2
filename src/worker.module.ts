import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggingModule } from './common/logging.module.js';
import { validateEnv } from './config/env.js';
import { CreditsModule } from './credits/credits.module.js';
import { EmailModule } from './email/email.module.js';
import { DataModule } from './database/data.module.js';
import { DatabaseModule } from './database/database.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

/** Root module for the background worker: same config and database as the API, no HTTP controllers. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggingModule,
    DatabaseModule,
    DataModule,
    CreditsModule,
    WorkspacesModule,
    EmailModule,
  ],
})
export class WorkerModule {}
