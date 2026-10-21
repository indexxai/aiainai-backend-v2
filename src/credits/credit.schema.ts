import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

export const BUCKETS = ['plan', 'topup'] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * Current balance per workspace. Every change happens in the same database transaction as
 * the ledger entries that explain it, and spending uses a conditional update, so two
 * requests at the same moment can never spend the same credits.
 */
@Schema({ collection: 'credit_accounts', timestamps: true, versionKey: false })
export class CreditAccount {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, unique: true })
  workspaceId!: Types.ObjectId;
  /** Monthly plan credits; reset each period. */
  @Prop({ type: Number, required: true, default: 0, min: 0 }) plan!: number;
  /** Bought credits; roll over. Used after plan credits. */
  @Prop({ type: Number, required: true, default: 0, min: 0 }) topup!: number;
  /** Reserved by running jobs; not spendable until charged or released. */
  @Prop({ type: Number, required: true, default: 0, min: 0 }) held!: number;
}
export type CreditAccountDocument = HydratedDocument<CreditAccount>;
export const CreditAccountSchema = SchemaFactory.createForClass(CreditAccount);

export const ENTRY_TYPES = [
  'grant',
  'topup',
  'hold',
  'release',
  'charge',
  'refund',
  'expire',
  'adjustment',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/**
 * The ledger: an append-only history of every credit movement. Entries are never edited or
 * deleted; mistakes are corrected with an `adjustment` entry. The sum of a bucket's entries
 * always equals that bucket in CreditAccount (checked by a reconciliation job).
 */
@Schema({
  collection: 'credit_entries',
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
})
export class CreditEntry {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true, enum: ENTRY_TYPES }) type!: EntryType;
  @Prop({ type: String, required: true, enum: BUCKETS }) bucket!: Bucket;
  /** Signed: positive adds spendable credits, negative removes them. */
  @Prop({ type: Number, required: true }) amount!: number;
  /** Change to `held` (positive when reserving, negative when settling). */
  @Prop({ type: Number, default: 0 }) heldDelta!: number;
  /** Links a hold to the release/charge that settles it. */
  @Prop({ type: String }) holdId?: string;
  /**
   * Unique per workspace. Retrying an operation with the same key returns the first result
   * instead of moving credits again (double clicks, network retries, duplicate webhooks).
   */
  @Prop({ type: String, required: true }) idempotencyKey!: string;
  @Prop({ type: String, required: true, maxlength: 200 }) reason!: string;
  /** What this was for, e.g. { kind: 'message', id: '...' } or { kind: 'stripe_invoice', id: 'in_...' }. */
  @Prop({ type: Object }) ref?: { kind: string; id: string };
  @Prop({ type: String }) actor?: string;
}
export type CreditEntryDocument = HydratedDocument<CreditEntry>;
export const CreditEntrySchema = SchemaFactory.createForClass(CreditEntry);
CreditEntrySchema.index({ workspaceId: 1, idempotencyKey: 1, bucket: 1 }, { unique: true });
CreditEntrySchema.index({ workspaceId: 1, createdAt: -1 });
CreditEntrySchema.index({ workspaceId: 1, holdId: 1 });
