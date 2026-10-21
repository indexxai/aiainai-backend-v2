import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const MEMORY_GROUPS = ['about', 'people', 'habits', 'preferences'] as const;
export type MemoryGroup = (typeof MEMORY_GROUPS)[number];

/**
 * Something Jack knows about the person (or, in Business, the business): told by them or
 * learned in a conversation. Kept per space; forgetting deletes it for good.
 */
@Schema({ ...baseSchemaOptions, collection: 'memories' })
export class Memory {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true }) createdBy!: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 300 }) text!: string;
  @Prop({ type: String, enum: MEMORY_GROUPS, default: 'about' }) group!: MemoryGroup;
  /** you: added on the Memory page · jack: learned in a conversation */
  @Prop({ type: String, enum: ['you', 'jack'], default: 'you' }) source!: 'you' | 'jack';
  /** The conversation it was learned in. */
  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null }) chatId?: Types.ObjectId | null;
  /** Lower-case text without punctuation, to avoid saving the same thing twice. */
  @Prop({ type: String, required: true }) key!: string;
}

export type MemoryDocument = HydratedDocument<Memory>;
export const MemorySchema = SchemaFactory.createForClass(Memory);
MemorySchema.index({ workspaceId: 1, createdAt: -1 });
MemorySchema.index({ workspaceId: 1, key: 1 }, { unique: true });
