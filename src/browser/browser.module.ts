import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ActionsModule } from '../actions/actions.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { BrowserbaseDriver } from './browserbase-driver.js';
import { BrowserController } from './browser.controller.js';
import { BrowserService } from './browser.service.js';
import { BROWSER_DRIVER, type BrowserDriver } from './driver.js';
import { SampleDriver } from './sample-driver.js';

/** Browserbase with a key; sample mode otherwise (Jack's browser is off in production without a key). */
export function createBrowserDriver(config: ConfigService<Env, true>): BrowserDriver {
  const key = config.get('BROWSERBASE_API_KEY', { infer: true });
  const project = config.get('BROWSERBASE_PROJECT_ID', { infer: true });
  if (key && project) return new BrowserbaseDriver(key, project);
  return new SampleDriver(
    config.get('BROWSER_SAMPLE_STEP_MS', { infer: true }) ?? 1500,
    config.get('NODE_ENV', { infer: true }) !== 'production',
  );
}

@Module({
  imports: [ActionsModule, WalletModule, GatewayModule, WorkspacesModule],
  controllers: [BrowserController],
  providers: [
    BrowserService,
    { provide: BROWSER_DRIVER, useFactory: createBrowserDriver, inject: [ConfigService] },
  ],
  exports: [BrowserService],
})
export class BrowserModule {}
