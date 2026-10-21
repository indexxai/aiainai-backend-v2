import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { LoggingModule } from './common/logging.module.js';
import { validateEnv } from './config/env.js';
import { CreditsModule } from './credits/credits.module.js';
import { DataModule } from './database/data.module.js';
import { DatabaseModule } from './database/database.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { EmailModule } from './email/email.module.js';
import { HealthModule } from './health/health.module.js';
import { MeModule } from './me/me.module.js';
import { BillingModule } from './billing/billing.module.js';
import { ImagesModule } from './images/images.module.js';
import { StorageModule } from './storage/storage.module.js';
import { DocsModule } from './docs/docs.module.js';
import { ChatsModule } from './chats/chats.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { ModelsModule } from './models/models.module.js';
import { SpacesModule } from './spaces/spaces.module.js';
import { HomeModule } from './home/home.module.js';
import { ActivityModule } from './activity/activity.module.js';
import { MemoryModule } from './memory/memory.module.js';
import { ConnectionsModule } from './connections/connections.module.js';
import { WalletModule } from './wallet/wallet.module.js';
import { ActionsModule } from './actions/actions.module.js';
import { BrowserModule } from './browser/browser.module.js';
import { VoiceModule } from './voice/voice.module.js';
import { FilesModule } from './files/files.module.js';
import { ProjectsModule } from './projects/projects.module.js';

/**
 * Root module for the HTTP API. Feature modules (auth, models, chat, credits, files,
 * docs, images, research, admin, notifications) are added here as they are built.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggingModule,
    DatabaseModule,
    DataModule,
    CreditsModule,
    WorkspacesModule,
    EmailModule,
    AuthModule,
    HealthModule,
    MeModule,
    ModelsModule,
    GatewayModule,
    ChatsModule,
    BillingModule,
    DocsModule,
    StorageModule,
    ImagesModule,
    SpacesModule,
    HomeModule,
    ActivityModule,
    MemoryModule,
    ConnectionsModule,
    WalletModule,
    ActionsModule,
    BrowserModule,
    VoiceModule,
    FilesModule,
    ProjectsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
