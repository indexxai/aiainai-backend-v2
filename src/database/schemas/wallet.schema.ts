import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

/**
 * How Jack pays in one space: the card, the limits and the sites he must never use. Every
 * purchase also needs the person's OK (always on). Payments are in test mode until a
 * card-issuing provider is approved (see OPEN_DECISIONS).
 */
@Schema({ ...baseSchemaOptions, collection: 'wallets' })
export class Wallet {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, unique: true })
  workspaceId!: Types.ObjectId;
  @Prop({ type: String, default: 'PKR', maxlength: 3 }) currency!: string;
  /** Limits in whole currency units; 0 means no purchases at all. */
  @Prop({ type: Number, default: 150_000, min: 0 }) perPurchase!: number;
  @Prop({ type: Number, default: 200_000, min: 0 }) perDay!: number;
  @Prop({ type: Number, default: 500_000, min: 0 }) perMonth!: number;
  /** Sites (domains) and kinds of sites Jack must never open or pay on. */
  @Prop({ type: [String], default: ['banking', 'government', 'gambling'] }) blockedSites!: string[];
  /** The card one-time cards are made from (test mode: a test card). */
  @Prop({ type: Object, default: null }) card?: { brand: string; last4: string } | null;
}

export type WalletDocument = HydratedDocument<Wallet>;
export const WalletSchema = SchemaFactory.createForClass(Wallet);

/** One payment Jack made (or tried to make) after the person approved it. */
@Schema({ ...baseSchemaOptions, collection: 'receipts' })
export class Receipt {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'JackAction', required: true }) actionId!: Types.ObjectId;
  @Prop({ type: String, required: true, maxlength: 200 }) item!: string;
  @Prop({ type: String, required: true, maxlength: 120 }) seller!: string;
  @Prop({ type: String, default: '' }) site!: string;
  @Prop({ type: Number, required: true, min: 0 }) amount!: number;
  @Prop({ type: String, required: true }) currency!: string;
  @Prop({ type: String, enum: ['paid', 'refunded', 'failed'], default: 'paid' }) status!:
    'paid' | 'refunded' | 'failed';
  /** Test mode: no real money moved. */
  @Prop({ type: Boolean, default: true }) test!: boolean;
  /** Last four digits of the one-time card used. */
  @Prop({ type: String, default: '' }) cardLast4!: string;
}

export type ReceiptDocument = HydratedDocument<Receipt>;
export const ReceiptSchema = SchemaFactory.createForClass(Receipt);
ReceiptSchema.index({ workspaceId: 1, createdAt: -1 });
