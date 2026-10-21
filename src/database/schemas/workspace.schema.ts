import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/** Spaces: everyone has a Personal space; a Business space is added when they set one up. */
export const SPACE_KINDS = ['personal', 'business'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/** What the person told Jack about the business at set-up. */
export class BusinessProfile {
  website?: string;
  about?: string;
  /** What Jack should help with first, e.g. "leads", "social". */
  helpWith?: string[];
}

/**
 * The owner of all data. Each person has a Personal workspace (their plan and credits live
 * here) and can add one Business workspace. Every record belongs to one workspace, so the two
 * spaces never see each other's chats, docs, images, team or memory. The Business workspace
 * spends credits from its parent's plan.
 */
@Schema({ ...baseSchemaOptions, collection: 'workspaces' })
export class Workspace {
  @Prop({ type: String, required: true, trim: true, maxlength: 120 }) name!: string;
  /** Better Auth user id of the owner. */
  @Prop({ type: String, required: true, index: true }) ownerUserId!: string;
  @Prop({ type: String, required: true, enum: PLANS, default: 'free' }) plan!: Plan;
  /** Start of the current plan period; plan credits reset at the next period. */
  @Prop({ type: Date, required: true, default: () => new Date() }) periodStart!: Date;
  @Prop({ type: Date, required: true }) periodEnd!: Date;
  /** Plan periods are counted in whole months from here (the day a paid plan started). */
  @Prop({ type: Date }) planAnchor?: Date;
  /** Jack Personal is paid up to this moment (one-time payments, a month each). */
  @Prop({ type: Date, default: null }) proUntil?: Date | null;
  /** Checkout sessions already applied to this plan, so a payment never counts twice. */
  @Prop({ type: [String], default: [] }) appliedPayments!: string[];
  @Prop({ type: String }) stripeCustomerId?: string;
  @Prop({ type: String, enum: SPACE_KINDS, default: 'personal' }) kind!: SpaceKind;
  /** Business only: the owner's Personal workspace, which pays for it. */
  @Prop({ type: Types.ObjectId, ref: 'Workspace' }) parentWorkspaceId?: Types.ObjectId;
  @Prop({ type: Object }) business?: BusinessProfile;
  /** "Let Jack remember new things" for this space. Saved memories are used either way. */
  @Prop({ type: Boolean, default: true }) memoryEnabled!: boolean;
  /** Personal only: the name the person gave their assistant (null: "Jack"). */
  @Prop({ type: String, default: null, maxlength: 40 }) assistantName?: string | null;
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type WorkspaceDocument = HydratedDocument<Workspace>;
export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
WorkspaceSchema.index({ stripeCustomerId: 1 }, { unique: true, sparse: true });
// One Business space per person for now.
WorkspaceSchema.index(
  { parentWorkspaceId: 1 },
  { unique: true, partialFilterExpression: { kind: 'business' } },
);
