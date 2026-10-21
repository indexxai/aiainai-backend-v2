import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const PAYMENT_KINDS = ['topup', 'plan'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_STATUSES = ['pending', 'paid', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * One checkout: a credit top-up or a month of a plan, paid once through Stripe Checkout.
 * Created when the person starts paying; marked paid by the webhook (or when they come back).
 */
@Schema({ ...baseSchemaOptions, collection: 'payments' })
export class Payment {
  /** The Personal workspace that pays (plan and credits live there). */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;
  @Prop({ type: String }) userId?: string;
  /** Stripe Checkout Session id (cs_…), or sample_… for the local stand-in. */
  @Prop({ type: String, required: true, unique: true }) sessionId!: string;
  @Prop({ type: String, required: true, enum: PAYMENT_KINDS }) kind!: PaymentKind;
  /** Pack id ("500", "1200", "3000") or plan key ("pro"). */
  @Prop({ type: String, required: true }) product!: string;
  /** Credits bought (top-ups) or granted for the month (plans). */
  @Prop({ type: Number, default: 0 }) credits!: number;
  @Prop({ type: Number, required: true }) amountCents!: number;
  @Prop({ type: String, default: 'usd' }) currency!: string;
  @Prop({ type: String, enum: PAYMENT_STATUSES, default: 'pending' }) status!: PaymentStatus;
  @Prop({ type: Date, default: null }) paidAt?: Date | null;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
