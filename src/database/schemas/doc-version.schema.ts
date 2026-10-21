import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

/**
 * first: the AI's finished draft · auto: saved while editing (at most every few minutes) ·
 * ai: right after an accepted AI change · named: the person named it · restore: saved just
 * before an older version was restored.
 */
export const VERSION_KINDS = ['first', 'auto', 'ai', 'named', 'restore'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

/** A saved copy of a document at one moment. Older than the plan's history window → removed. */
@Schema({ ...baseSchemaOptions, collection: 'doc_versions' })
export class DocVersion {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'DocumentRecord', required: true }) docId!: Types.ObjectId;
  @Prop({ type: String, enum: VERSION_KINDS, required: true }) kind!: VersionKind;
  @Prop({ type: String, required: true, maxlength: 120 }) name!: string;
  /** Who made the change: a user id, or 'assistant'. */
  @Prop({ type: String, required: true }) by!: string;
  @Prop({ type: String, default: '' }) title!: string;
  @Prop({ type: String, default: '' }) markdown!: string;
  @Prop({ type: Object, default: null }) content?: Record<string, unknown> | null;
  @Prop({ type: String, default: '' }) text!: string;
  @Prop({ type: Number, default: 0 }) wordCount!: number;
}

export type DocVersionDocument = HydratedDocument<DocVersion>;
export const DocVersionSchema = SchemaFactory.createForClass(DocVersion);
DocVersionSchema.index({ docId: 1, createdAt: -1 });
DocVersionSchema.index({ workspaceId: 1, createdAt: 1 });
