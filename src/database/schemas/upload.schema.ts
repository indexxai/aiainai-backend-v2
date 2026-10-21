import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const UPLOAD_KINDS = ['pdf', 'word', 'sheet', 'text', 'image'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * A file the person gave Jack (attached in a chat, or added on the Files page). The bytes live in
 * storage under `storageKey`; the text Jack reads is extracted once, on upload.
 */
@Schema({ ...baseSchemaOptions, collection: 'uploads' })
export class Upload {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true }) userId!: string;
  @Prop({ type: String, required: true, maxlength: 200 }) name!: string;
  @Prop({ type: String, required: true }) contentType!: string;
  @Prop({ type: String, required: true, enum: UPLOAD_KINDS }) kind!: UploadKind;
  @Prop({ type: Number, required: true }) bytes!: number;
  @Prop({ type: String, required: true }) storageKey!: string;
  /** What Jack reads: the file's text (or, for an image, a description of it). */
  @Prop({ type: String, default: '' }) text!: string;
  /** The text was cut to fit (very long files). */
  @Prop({ type: Boolean, default: false }) truncated!: boolean;
  @Prop({ type: Number }) pages?: number;
  /** Why Jack can't read it (e.g. a scanned PDF without text). The file is still kept. */
  @Prop({ type: String, default: null }) note?: string | null;
  /** Credits used to read it (describing an image). */
  @Prop({ type: Number, default: 0 }) credits!: number;
  /** The project it belongs to: Jack reads it in every chat of that project. */
  @Prop({ type: Types.ObjectId, ref: 'Project', default: null }) projectId?: Types.ObjectId | null;
  /** The chat it was first attached in, if any. */
  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null }) chatId?: Types.ObjectId | null;
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type UploadDocument = HydratedDocument<Upload>;
export const UploadSchema = SchemaFactory.createForClass(Upload);
UploadSchema.index({ workspaceId: 1, deletedAt: 1, createdAt: -1 });
