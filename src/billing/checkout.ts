import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';

export const CHECKOUT = Symbol('CHECKOUT');

export interface CheckoutInput {
  name: string;
  description: string;
  amountCents: number;
  /** Who is paying, for Stripe's records and receipt emails. */
  email?: string;
  customerId?: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  id: string;
  paid: boolean;
  /** Still waiting for the person (or a delayed payment method). */
  open: boolean;
  amountCents: number;
  currency: string;
  customerId?: string;
  metadata: Record<string, string>;
}

export type CheckoutEvent =
  { type: 'paid'; session: CheckoutSession } | { type: 'expired'; sessionId: string } | { type: 'ignored' };

/** Takes one-time payments: Stripe Checkout, or a sample stand-in outside production. */
export interface Checkout {
  readonly mode: 'live' | 'sample' | 'off';
  create(input: CheckoutInput): Promise<{ id: string; url: string }>;
  retrieve(id: string): Promise<CheckoutSession>;
  /** Verify a webhook's signature and read it. Throws when the signature doesn't match. */
  parseWebhook(raw: Buffer, signature: string): CheckoutEvent;
}

function fromStripe(s: Stripe.Checkout.Session): CheckoutSession {
  return {
    id: s.id,
    paid: s.payment_status === 'paid' || s.payment_status === 'no_payment_required',
    open: s.status === 'open' || (s.status === 'complete' && s.payment_status === 'unpaid'),
    amountCents: s.amount_total ?? 0,
    currency: s.currency ?? 'usd',
    customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id,
    metadata: (s.metadata ?? {}) as Record<string, string>,
  };
}

/** Stripe-hosted Checkout: card details never reach our servers. */
export class StripeCheckout implements Checkout {
  readonly mode = 'live' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret?: string,
  ) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: 'aiainai' } });
  }

  async create(input: CheckoutInput) {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: input.amountCents,
            product_data: { name: input.name, description: input.description },
          },
        },
      ],
      ...(input.customerId
        ? { customer: input.customerId }
        : { customer_email: input.email, customer_creation: 'always' as const }),
      client_reference_id: input.metadata.workspaceId,
      metadata: input.metadata,
      payment_intent_data: { metadata: input.metadata, description: input.name },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { id: session.id, url: session.url };
  }

  async retrieve(id: string) {
    return fromStripe(await this.stripe.checkout.sessions.retrieve(id));
  }

  parseWebhook(raw: Buffer, signature: string): CheckoutEvent {
    if (!this.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    const event = this.stripe.webhooks.constructEvent(raw, signature, this.webhookSecret);
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = fromStripe(event.data.object);
        return session.paid ? { type: 'paid', session } : { type: 'ignored' };
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        return { type: 'expired', sessionId: event.data.object.id };
      default:
        return { type: 'ignored' };
    }
  }
}

/** Local stand-in: "paying" sends the person straight back as if the card went through. */
export class SampleCheckout implements Checkout {
  readonly mode = 'sample' as const;
  private readonly sessions = new Map<string, CheckoutSession>();

  async create(input: CheckoutInput) {
    const id = `sample_${randomUUID().replace(/-/g, '')}`;
    this.sessions.set(id, {
      id,
      paid: true,
      open: false,
      amountCents: input.amountCents,
      currency: 'usd',
      metadata: input.metadata,
    });
    return { id, url: input.successUrl.replace('{CHECKOUT_SESSION_ID}', id) };
  }

  async retrieve(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('No such checkout');
    return s;
  }

  parseWebhook(): CheckoutEvent {
    return { type: 'ignored' };
  }
}

/** Payments switched off (production without a Stripe key). */
export class NoCheckout implements Checkout {
  readonly mode = 'off' as const;
  create(): Promise<never> {
    throw new Error('Payments are off');
  }
  retrieve(): Promise<never> {
    throw new Error('Payments are off');
  }
  parseWebhook(): CheckoutEvent {
    return { type: 'ignored' };
  }
}
