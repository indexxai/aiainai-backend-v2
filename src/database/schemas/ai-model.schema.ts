import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';
import { PLANS } from './workspace.schema.js';

export const MODEL_KINDS = ['text', 'image'] as const;
export const MODEL_STATUS = ['live', 'hidden', 'paused'] as const;

/**
 * The model registry: everything the model menus, the gateway and billing need.
 * Edited from Admin later; seeded by `pnpm seed`. Code never hard-codes prices.
 */
@Schema({ ...baseSchemaOptions, collection: 'ai_models' })
export class AiModel {
  /** Stable id used everywhere in the app, e.g. "claude-sonnet". */
  @Prop({ type: String, required: true, unique: true }) key!: string;
  @Prop({ type: String, required: true, enum: MODEL_KINDS }) kind!: (typeof MODEL_KINDS)[number];
  @Prop({ type: String, required: true }) name!: string;
  @Prop({ type: String, required: true }) provider!: string;
  /** Provider's API model id; set when the account and key are ready. */
  @Prop({ type: String, default: '' }) providerModelId!: string;
  /**
   * OpenRouter's id for the same model (e.g. "<maker>/<model>"); set with `pnpm models:configure`.
   * When the OpenRouter key is set, models with this id are called through OpenRouter.
   */
  @Prop({ type: String, default: '' }) openrouterModelId!: string;
  @Prop({ type: String, required: true }) description!: string;
  @Prop({ type: [String], default: [] }) tags!: string[];
  /** Text: credits per message. Image: credits per image. */
  @Prop({ type: Number, required: true, min: 0 }) credits!: number;
  @Prop({ type: [String], enum: PLANS, default: ['free', 'pro'] }) plans!: string[];
  @Prop({ type: Boolean, default: true }) autoEligible!: boolean;
  @Prop({ type: String, enum: MODEL_STATUS, default: 'hidden' }) status!: (typeof MODEL_STATUS)[number];
  @Prop({ type: Number, default: 0 }) sortOrder!: number;
  /**
   * What the provider charges us, in micro-dollars per million tokens (text) or per image.
   * Used only for the margin numbers in usage events; 0 until set by `pnpm models:configure`.
   */
  @Prop({ type: Number, default: 0, min: 0 }) inputPriceMicros!: number;
  @Prop({ type: Number, default: 0, min: 0 }) outputPriceMicros!: number;
}

export type AiModelDocument = HydratedDocument<AiModel>;
export const AiModelSchema = SchemaFactory.createForClass(AiModel);
AiModelSchema.index({ kind: 1, status: 1, sortOrder: 1 });
