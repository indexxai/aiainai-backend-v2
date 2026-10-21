import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Types } from 'mongoose';
import { createAuth, type Auth } from '../auth/auth.factory.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AUTH } from '../auth/auth.tokens.js';
import { BillingController } from '../billing/billing.controller.js';
import { BillingService } from '../billing/billing.service.js';
import { CHECKOUT, SampleCheckout } from '../billing/checkout.js';
import { PaymentsService } from '../billing/payments.service.js';
import { PaymentSchema } from '../database/schemas/payment.schema.js';
import { ImagesController } from '../images/images.controller.js';
import { ImagesService } from '../images/images.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ImageGenerationSchema } from '../database/schemas/image.schema.js';
import { DocsController } from '../docs/docs.controller.js';
import { DocsService } from '../docs/docs.service.js';
import { DocsExportService } from '../docs/docs-export.service.js';
import { DocsSharingService } from '../docs/docs-sharing.service.js';
import { DocsVersionsController } from '../docs/docs-versions.controller.js';
import { DocsVersionsService } from '../docs/docs-versions.service.js';
import { PublicDocsController } from '../docs/public-docs.controller.js';
import { EmailService } from '../email/email.service.js';
import { DocVersionSchema } from '../database/schemas/doc-version.schema.js';
import { DocumentRecordSchema } from '../database/schemas/document.schema.js';
import { ChatsController } from '../chats/chats.controller.js';
import { ChatsService } from '../chats/chats.service.js';
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js';
import { CreditEntrySchema } from '../credits/credit.schema.js';
import { CreditsService } from '../credits/credits.service.js';
import { AiModelSchema } from '../database/schemas/ai-model.schema.js';
import { ChatSchema, MessageSchema } from '../database/schemas/chat.schema.js';
import { UsageEventSchema } from '../database/schemas/usage-event.schema.js';
import { ONBOARDING_PENDING, UserProfileSchema } from '../database/schemas/user-profile.schema.js';
import { WorkspaceSchema, type Plan, type Workspace } from '../database/schemas/workspace.schema.js';
import { SpacesController } from '../spaces/spaces.controller.js';
import { HomeController } from '../home/home.controller.js';
import { HomeService } from '../home/home.service.js';
import { JackService } from '../jack/jack.service.js';
import { ActivityController } from '../activity/activity.controller.js';
import { ActivityService } from '../activity/activity.service.js';
import { MemorySchema } from '../database/schemas/memory.schema.js';
import { ConnectionSchema } from '../database/schemas/connection.schema.js';
import { MemoryController } from '../memory/memory.controller.js';
import { MemoryService } from '../memory/memory.service.js';
import { ConnectionsController } from '../connections/connections.controller.js';
import { ConnectionsService } from '../connections/connections.service.js';
import { CONNECTOR } from '../connections/connector.js';
import { DemoConnector } from '../connections/demo-connector.js';
import { ReceiptSchema, WalletSchema } from '../database/schemas/wallet.schema.js';
import { JackActionSchema } from '../database/schemas/jack-action.schema.js';
import { BrowserTaskSchema } from '../database/schemas/browser-task.schema.js';
import { WalletController } from '../wallet/wallet.controller.js';
import { WalletService } from '../wallet/wallet.service.js';
import { ActionsController } from '../actions/actions.controller.js';
import { ActionsService } from '../actions/actions.service.js';
import { BrowserController } from '../browser/browser.controller.js';
import { BrowserService } from '../browser/browser.service.js';
import { BROWSER_DRIVER } from '../browser/driver.js';
import { SampleDriver } from '../browser/sample-driver.js';
import type { Connection, Model } from 'mongoose';
import type { UserProfile } from '../database/schemas/user-profile.schema.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { MeController } from '../me/me.controller.js';
import { ModelsController } from '../models/models.controller.js';
import { ModelsService } from '../models/models.service.js';
import { MODEL_SEED } from '../models/registry.seed.js';
import { periodEndFrom } from '../plans/plans.config.js';
import { configureApp } from '../setup.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { FakeCredits } from './fake-credits.js';
import { VoiceController } from '../voice/voice.controller.js';
import { VoiceService } from '../voice/voice.service.js';
import { UploadSchema } from '../database/schemas/upload.schema.js';
import { FilesController } from '../files/files.controller.js';
import { FilesService } from '../files/files.service.js';
import { ProjectsController } from '../projects/projects.controller.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ProjectSchema } from '../database/schemas/project.schema.js';
import { ProjectContextService } from '../projects/project-context.service.js';
import { MemoryModel } from './memory-model.js';

export interface MemoryAppOptions {
  plan?: Plan;
  credits?: number;
  appUrl?: string;
  /** Delay between words of the stand-in model's answers. */
  demoDelayMs?: number;
  /** Time the stand-in takes per image. */
  demoImageDelayMs?: number;
  /** Pace of the sample browser's steps. */
  browserStepMs?: number;
  /** Receives sign-up and reset codes (they are not emailed). */
  onCode?: (email: string, code: string, kind: string) => void;
  /** Business space on (default, or BUSINESS_SPACE=off in the environment to try it closed). */
  businessSpace?: boolean;
  /** Sign-up email codes on (default, or EMAIL_VERIFICATION=off in the environment to skip them). */
  emailVerification?: boolean;
}

/**
 * The real API (controllers, services, gateway, auth) on in-memory storage, with the stand-in
 * model. For local end-to-end tests and demos where MongoDB isn't available.
 * Not used in production; nothing is persisted.
 */
export async function createMemoryApp(opts: MemoryAppOptions = {}): Promise<INestApplication> {
  const plan = opts.plan ?? 'free';
  const store = {
    Chat: new MemoryModel('Chat', ChatSchema),
    Message: new MemoryModel('Message', MessageSchema),
    UsageEvent: new MemoryModel('UsageEvent', UsageEventSchema),
    UserProfile: new MemoryModel('UserProfile', UserProfileSchema),
    Workspace: new MemoryModel('Workspace', WorkspaceSchema),
    Memory: new MemoryModel('Memory', MemorySchema),
    Connection: new MemoryModel('Connection', ConnectionSchema),
    Wallet: new MemoryModel('Wallet', WalletSchema),
    Receipt: new MemoryModel('Receipt', ReceiptSchema),
    JackAction: new MemoryModel('JackAction', JackActionSchema),
    BrowserTask: new MemoryModel('BrowserTask', BrowserTaskSchema),
    Upload: new MemoryModel('Upload', UploadSchema),
    Project: new MemoryModel('Project', ProjectSchema),
    AiModel: new MemoryModel('AiModel', AiModelSchema),
    CreditEntry: new MemoryModel('CreditEntry', CreditEntrySchema),
    DocumentRecord: new MemoryModel('DocumentRecord', DocumentRecordSchema),
    DocVersion: new MemoryModel('DocVersion', DocVersionSchema),
    ImageGeneration: new MemoryModel('ImageGeneration', ImageGenerationSchema),
    Payment: new MemoryModel('Payment', PaymentSchema),
  };
  await store.AiModel.create(MODEL_SEED.map((m) => ({ ...m, providerModelId: '', status: 'hidden' })));
  const credits = new FakeCredits(0, store.CreditEntry);

  // The real WorkspacesService (spaces, Business set-up) on in-memory storage; only creating the
  // Personal workspace is simplified (no transaction, a fixed credit grant for tests).
  const fakeWorkspaces = new WorkspacesService(
    {} as Connection,
    store.Workspace as unknown as Model<Workspace>,
    store.UserProfile as unknown as Model<UserProfile>,
    credits as unknown as CreditsService,
  );
  fakeWorkspaces.ensureForUser = async (user: { id: string; name?: string }) => {
    const profile = (await store.UserProfile.findOne({ userId: user.id }).lean()) as {
      workspaceId: Types.ObjectId;
    } | null;
    if (profile) return (await store.Workspace.findById(profile.workspaceId).lean()) as never;
    const ws = (await store.Workspace.create({
      name: `${user.name ?? 'My'}’s workspace`,
      ownerUserId: user.id,
      plan,
      kind: 'personal',
      periodStart: new Date(),
      periodEnd: periodEndFrom(new Date()),
    })) as { _id: Types.ObjectId };
    await store.UserProfile.create({
      userId: user.id,
      workspaceId: ws._id,
      onboarding: { use: ONBOARDING_PENDING },
    });
    await credits.grant({
      workspaceId: ws._id,
      bucket: 'plan',
      amount: opts.credits ?? 100,
      key: `plan:${ws._id.toHexString()}`,
      reason: `${plan === 'pro' ? 'Jack Personal' : 'Jack Free'} monthly credits`,
    });
    return ws as never;
  };

  const auth: Auth = createAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    appUrl: opts.appUrl ?? 'http://localhost:3000',
    secret: 'memory-app-secret-memory-app-secret-123',
    production: false,
    verifyEmail: opts.emailVerification ?? process.env.EMAIL_VERIFICATION !== 'off',
    sendCode: async (email, code, kind) => opts.onCode?.(email, code, kind),
    onUserCreated: async (user) => {
      await fakeWorkspaces.ensureForUser(user);
    },
  });

  const delay = opts.demoDelayMs ?? 30;

  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            NODE_ENV: 'development',
            AI_DEMO: true,
            STORAGE_DRIVER: 'memory',
            APP_URL: opts.appUrl ?? 'http://localhost:3000',
          }),
        ],
      }),
    ],
    controllers: [
      MeController,
      ModelsController,
      ChatsController,
      BillingController,
      DocsController,
      DocsVersionsController,
      PublicDocsController,
      ImagesController,
      SpacesController,
      HomeController,
      ActivityController,
      MemoryController,
      ConnectionsController,
      WalletController,
      ActionsController,
      BrowserController,
      VoiceController,
      FilesController,
      ProjectsController,
    ],
    providers: [
      ...Object.entries(store).map(([name, model]) => ({ provide: getModelToken(name), useValue: model })),
      { provide: CreditsService, useValue: credits },
      { provide: WorkspacesService, useValue: fakeWorkspaces },
      { provide: AUTH, useValue: auth },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ModelsService,
      GatewayService,
      ChatsService,
      BillingService,
      PaymentsService,
      { provide: CHECKOUT, useValue: new SampleCheckout() },
      DocsService,
      DocsSharingService,
      DocsVersionsService,
      DocsExportService,
      EmailService,
      ImagesService,
      StorageService,
      HomeService,
      JackService,
      ActivityService,
      MemoryService,
      ConnectionsService,
      { provide: CONNECTOR, useValue: new DemoConnector() },
      WalletService,
      ActionsService,
      BrowserService,
      VoiceService,
      FilesService,
      ProjectsService,
      ProjectContextService,
      { provide: BROWSER_DRIVER, useValue: new SampleDriver(opts.browserStepMs ?? 1200) },
      { provide: getConnectionToken(), useValue: {} },
    ],
  })
  class MemoryAppModule {}

  const app = await NestFactory.create<NestExpressApplication>(MemoryAppModule, {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  configureApp(app, auth, {
    appUrl: opts.appUrl ?? 'http://localhost:3000',
    businessSpace: opts.businessSpace ?? process.env.BUSINESS_SPACE !== 'off',
  });
  // Slow the stand-in down so streaming and Stop can be seen and tested.
  const models = app.get(ModelsService);
  const original = models.providers.languageModel.bind(models.providers);
  models.providers.languageModel = (m) => {
    const lm = original(m) as unknown as { delayMs?: number };
    if ('delayMs' in lm) Object.assign(lm, { delayMs: delay });
    return lm as never;
  };
  models.providers.demoImageDelayMs = opts.demoImageDelayMs ?? 1500;
  return app;
}
