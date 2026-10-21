import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

/** A folder that groups chats, documents, files and images. */
@Schema({ ...baseSchemaOptions, collection: 'projects' })
export class Project {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true, trim: true, maxlength: 120 }) name!: string;
  /** What Jack should know or do in every chat of this project (tone, goals, background). */
  @Prop({ type: String, default: '', maxlength: 4000 }) instructions!: string;
  @Prop({ type: String, required: true }) createdBy!: string;
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type ProjectDocument = HydratedDocument<Project>;
export const ProjectSchema = SchemaFactory.createForClass(Project);
ProjectSchema.index({ workspaceId: 1, deletedAt: 1, updatedAt: -1 });
