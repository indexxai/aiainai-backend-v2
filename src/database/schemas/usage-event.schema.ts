import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';

/**
 * One row per AI call: who, which model, tokens and the real provider cost.
 * Used for margins per model, the admin overview and investigating disputes. Never edited.
 */
@Schema({ collection: 'usage_events', timestamps: { createdAt: true, updatedAt: false }, versionKey: false })
export class UsageEvent {
  /** The workspace that paid (the person's plan). */
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  /** Set when the call was made in another space (a Business space), for the per-space split. */
  @Prop({ type: Types.ObjectId, ref: 'Workspace' }) spaceWorkspaceId?: Types.ObjectId;
  @Prop({ type: String, required: true }) userId!: string;
  /** chat | docs | image | research | team | files */
  @Prop({ type: String, required: true }) tool!: string;
  @Prop({ type: String, required: true }) modelKey!: string;
  @Prop({ type: String }) requestedModelKey?: string;
  @Prop({ type: String, required: true }) provider!: string;
  @Prop({ type: Number, default: 0 }) inputTokens!: number;
  @Prop({ type: Number, default: 0 }) outputTokens!: number;
  @Prop({ type: Number, default: 0 }) images!: number;
  /** What the provider charged us, in micro-dollars (1e-6 USD) to avoid float rounding. */
  @Prop({ type: Number, default: 0 }) providerCostMicros!: number;
  @Prop({ type: Number, default: 0 }) credits!: number;
  @Prop({ type: Number, default: 0 }) latencyMs!: number;
  @Prop({ type: String, enum: ['ok', 'failed', 'stopped', 'blocked'], default: 'ok' }) outcome!: string;
  @Prop({ type: String }) requestId?: string;
}

export type UsageEventDocument = HydratedDocument<UsageEvent>;
export const UsageEventSchema = SchemaFactory.createForClass(UsageEvent);
UsageEventSchema.index({ workspaceId: 1, createdAt: -1 });
UsageEventSchema.index({ modelKey: 1, createdAt: -1 });
