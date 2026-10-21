import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { CreditsModule } from '../credits/credits.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { CHECKOUT, NoCheckout, SampleCheckout, StripeCheckout, type Checkout } from './checkout.js';
import { PaymentsService } from './payments.service.js';

/** Stripe with a key; a sample checkout outside production; payments off in production otherwise. */
export function createCheckout(config: ConfigService<Env, true>): Checkout {
  const key = config.get('STRIPE_SECRET_KEY', { infer: true });
  if (key) return new StripeCheckout(key, config.get('STRIPE_WEBHOOK_SECRET', { infer: true }));
  return config.get('NODE_ENV', { infer: true }) === 'production' ? new NoCheckout() : new SampleCheckout();
}

@Module({
  imports: [CreditsModule, ModelsModule, WorkspacesModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    PaymentsService,
    { provide: CHECKOUT, useFactory: createCheckout, inject: [ConfigService] },
  ],
})
export class BillingModule {}
