import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { CreditsService } from '../credits/credits.service.js';
import { Payment, type PaymentKind } from '../database/schemas/payment.schema.js';
import { Workspace, type WorkspaceDocument } from '../database/schemas/workspace.schema.js';
import { PLAN_LIMITS } from '../plans/plans.config.js';
import { CHECKOUT, type Checkout, type CheckoutSession } from './checkout.js';
import { PLAN_PRICES, TOPUP_PACKS, planAfterPayment, type PackId, type PaidPlan } from './payments.logic.js';

export type CheckoutRequest = { kind: 'topup'; pack: PackId } | { kind: 'plan'; plan: PaidPlan };

export interface CheckoutResult {
  status: 'paid' | 'pending' | 'unpaid';
  kind: PaymentKind;
  credits: number;
  paidUntil: string | null;
}

const n = (x: number) => x.toLocaleString('en-US');

/** One-time payments: credit top-ups and a month of Jack Personal, through Stripe Checkout. */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(CHECKOUT) private readonly checkout: Checkout,
    private readonly credits: CreditsService,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Workspace.name) private readonly workspaces: Model<Workspace>,
  ) {}

  get mode() {
    return this.checkout.mode;
  }

  /** Start paying: returns the Stripe page to send the person to. */
  async start(
    ws: WorkspaceDocument,
    user: { id: string; email?: string },
    req: CheckoutRequest,
    appUrl: string,
  ): Promise<{ url: string }> {
    if (this.checkout.mode === 'off') {
      throw new AppError(
        'service_unavailable',
        'Payments aren’t set up yet.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const item =
      req.kind === 'topup'
        ? {
            product: req.pack,
            credits: TOPUP_PACKS[req.pack].credits,
            cents: TOPUP_PACKS[req.pack].cents,
            name: `${n(TOPUP_PACKS[req.pack].credits)} credits`,
            description: 'Jack’s AI credit top-up. Top-up credits never expire.',
            back: '/settings/billing',
          }
        : {
            product: req.plan,
            credits: PLAN_LIMITS[req.plan].monthlyCredits,
            cents: PLAN_PRICES[req.plan].cents,
            name: `${PLAN_PRICES[req.plan].label} · 1 month`,
            description: `${n(PLAN_LIMITS[req.plan].monthlyCredits)} credits and every model for one month. Doesn’t renew automatically.`,
            back: '/settings/billing/plans',
          };
    const metadata = {
      workspaceId: ws._id.toHexString(),
      kind: req.kind,
      product: item.product,
      userId: user.id,
    };
    let session: { id: string; url: string };
    try {
      session = await this.checkout.create({
        name: item.name,
        description: item.description,
        amountCents: item.cents,
        email: user.email,
        customerId: ws.stripeCustomerId,
        metadata,
        successUrl: `${appUrl}/settings/billing?checkout={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${appUrl}${item.back}?checkout=cancelled`,
      });
    } catch (err) {
      this.logger.error({ err, workspaceId: metadata.workspaceId }, 'Starting checkout failed');
      throw new AppError(
        'service_unavailable',
        'We couldn’t open the payment page. Please try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    await this.payments.create({
      workspaceId: ws._id,
      userId: user.id,
      sessionId: session.id,
      kind: req.kind,
      product: item.product,
      credits: item.credits,
      amountCents: item.cents,
    });
    return { url: session.url };
  }

  /**
   * The person is back from the payment page: check with Stripe and apply the payment if the
   * webhook hasn't yet (both are safe to run more than once).
   */
  async confirm(ws: WorkspaceDocument, sessionId: string): Promise<CheckoutResult> {
    const payment = await this.payments.findOne({ sessionId, workspaceId: ws._id }).lean();
    if (!payment) throw new AppError('not_found', 'We couldn’t find that payment.', HttpStatus.NOT_FOUND);
    if (payment.status !== 'paid') {
      const session = await this.checkout.retrieve(sessionId).catch((err: unknown) => {
        this.logger.warn({ err, sessionId }, 'Checking a checkout failed');
        return null;
      });
      if (session?.paid) await this.fulfill(session);
      else
        return {
          status: session?.open ? 'pending' : 'unpaid',
          kind: payment.kind,
          credits: payment.credits,
          paidUntil: null,
        };
    }
    const fresh = await this.workspaces.findById(ws._id).lean();
    return {
      status: 'paid',
      kind: payment.kind,
      credits: payment.credits,
      paidUntil: fresh?.proUntil ? new Date(fresh.proUntil).toISOString() : null,
    };
  }

  /** Paid payments, newest first (the Invoices tab). */
  async list(ws: WorkspaceDocument) {
    const rows = await this.payments
      .find({ workspaceId: ws._id, status: 'paid' })
      .sort({ paidAt: -1 })
      .limit(50)
      .lean();
    return {
      mode: this.checkout.mode,
      items: rows.map((p) => ({
        id: String(p._id),
        at: new Date(p.paidAt ?? (p as { createdAt?: Date }).createdAt ?? Date.now()).toISOString(),
        item:
          p.kind === 'topup'
            ? `${n(p.credits || TOPUP_PACKS[p.product as PackId]?.credits || 0)} credits`
            : `${PLAN_PRICES[p.product as PaidPlan]?.label ?? 'Plan'} · 1 month`,
        amountCents: p.amountCents,
        currency: p.currency ?? 'usd',
      })),
    };
  }

  /** Stripe webhook. Throws on a bad signature (answered 400 so Stripe shows it). */
  async webhook(raw: Buffer, signature: string): Promise<void> {
    const event = this.checkout.parseWebhook(raw, signature);
    if (event.type === 'paid') await this.fulfill(event.session);
    if (event.type === 'expired')
      await this.payments.updateOne(
        { sessionId: event.sessionId, status: 'pending' },
        { $set: { status: 'expired' } },
      );
  }

  /** Apply a paid checkout. Every step is idempotent, so retries and the webhook can't double-apply. */
  async fulfill(session: CheckoutSession): Promise<void> {
    const { workspaceId, kind, product } = session.metadata;
    const expected =
      kind === 'topup'
        ? TOPUP_PACKS[product as PackId]
        : kind === 'plan'
          ? { cents: PLAN_PRICES[product as PaidPlan]?.cents, credits: 0 }
          : undefined;
    if (!workspaceId || !Types.ObjectId.isValid(workspaceId) || !expected?.cents) {
      this.logger.warn({ sessionId: session.id, metadata: session.metadata }, 'Checkout without our details');
      return;
    }
    if (session.amountCents !== expected.cents) {
      this.logger.error(
        { sessionId: session.id, paid: session.amountCents, expected: expected.cents },
        'Checkout amount does not match the price; not applied',
      );
      return;
    }
    const wsId = new Types.ObjectId(workspaceId);
    await this.payments.updateOne(
      { sessionId: session.id },
      {
        $setOnInsert: {
          workspaceId: wsId,
          kind,
          product,
          credits: kind === 'topup' ? expected.credits : 0,
          amountCents: session.amountCents,
        },
        $set: { status: 'paid', paidAt: new Date(), currency: session.currency },
      },
      { upsert: true },
    );
    if (session.customerId)
      await this.workspaces.updateOne(
        { _id: wsId, stripeCustomerId: { $exists: false } },
        { $set: { stripeCustomerId: session.customerId } },
      );

    if (kind === 'topup') {
      await this.credits.grant({
        workspaceId: wsId,
        bucket: 'topup',
        amount: expected.credits,
        key: `stripe:${session.id}`,
        reason: `Bought ${n(expected.credits)} credits`,
        actor: session.metadata.userId,
      });
      return;
    }
    await this.applyPlan(wsId, product as PaidPlan, session.id);
  }

  private async applyPlan(wsId: Types.ObjectId, plan: PaidPlan, sessionId: string) {
    let mode: 'upgrade' | 'extend' | undefined;
    for (let attempt = 0; attempt < 5 && !mode; attempt++) {
      const ws = await this.workspaces.findById(wsId).lean();
      if (!ws) return;
      const done = (ws.appliedPayments ?? []).find((p) => p.startsWith(`${sessionId}|`));
      if (done) {
        mode = done.endsWith('|upgrade') ? 'upgrade' : 'extend';
        break;
      }
      const change = planAfterPayment(ws, new Date());
      // Only if nothing changed since we read it; otherwise read again and recompute.
      const res = await this.workspaces.updateOne(
        {
          _id: wsId,
          plan: ws.plan,
          periodEnd: ws.periodEnd,
          proUntil: ws.proUntil ?? null,
          appliedPayments: { $nin: [`${sessionId}|upgrade`, `${sessionId}|extend`] },
        },
        { $set: change.set, $push: { appliedPayments: `${sessionId}|${change.mode}` } },
      );
      if (res.matchedCount) {
        mode = change.mode;
        if (change.mode === 'upgrade')
          await this.workspaces.updateMany(
            { parentWorkspaceId: wsId },
            {
              $set: {
                plan: 'pro',
                periodStart: change.set.periodStart,
                periodEnd: change.set.periodEnd,
              },
            },
          );
      }
    }
    if (!mode) throw new Error(`Could not apply plan payment ${sessionId}`);
    if (mode === 'upgrade') {
      // Free's credits for this month give way to Personal's (top-ups stay).
      for (let attempt = 0; ; attempt++) {
        try {
          await this.credits.expirePlanCredits({
            workspaceId: wsId,
            key: `upgrade:${sessionId}`,
            reason: 'Free plan credits replaced by Jack Personal',
          });
          break;
        } catch (err) {
          if (attempt >= 2 || !(err instanceof AppError) || err.code !== 'conflict') throw err;
        }
      }
      await this.credits.grant({
        workspaceId: wsId,
        bucket: 'plan',
        amount: PLAN_LIMITS[plan].monthlyCredits,
        key: `stripe:${sessionId}`,
        reason: `${PLAN_LIMITS[plan].label} · 1 month paid`,
      });
    }
  }
}
