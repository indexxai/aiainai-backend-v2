import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import type { UploadKind } from './upload.schema.js';
import { baseSchemaOptions } from '../schema-options.js';

@Schema({ ...baseSchemaOptions, collection: 'chats' })
export class Chat {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Project', default: null }) projectId?: Types.ObjectId | null;
  @Prop({ type: String, required: true }) createdBy!: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 200, default: 'New chat' }) title!: string;
  /** Model chosen in the picker for the next message ('auto' or a registry id). */
  @Prop({ type: String, required: true, default: 'auto' }) model!: string;
  @Prop({ type: Number, default: 0 }) messageCount!: number;
  @Prop({ type: Date, default: () => new Date() }) lastMessageAt!: Date;
  /** Start of the latest message, for the chat list on phones. */
  @Prop({ type: String, default: '' }) preview!: string;
  /** Pinned chats are listed first. */
  @Prop({ type: Date, default: null }) pinnedAt?: Date | null;
  /** Connected apps (and 'browser') Jack must not use in this chat, chosen with the Connectors chip. */
  @Prop({ type: [String], default: [] }) appsOff!: string[];
  /** Public read-only link token when shared. */
  @Prop({ type: String }) shareToken?: string;
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type ChatDocument = HydratedDocument<Chat>;
export const ChatSchema = SchemaFactory.createForClass(Chat);
ChatSchema.index({ workspaceId: 1, deletedAt: 1, lastMessageAt: -1 });
ChatSchema.index({ shareToken: 1 }, { unique: true, sparse: true });
ChatSchema.index({ workspaceId: 1, title: 'text' });

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;

export const JACK_TOOLS = [
  'doc',
  'image',
  'calendar',
  'email',
  'browse',
  'send_email',
  'add_event',
  'drive',
  'slack',
  'send_slack',
] as const;
export type JackTool = (typeof JACK_TOOLS)[number];

/**
 * One thing Jack did with a tool while answering: started a document, images or team work, or
 * read the calendar or email (done at once). `status` is what happened when it started; while a
 * started step runs, its live state is read from the document, image batch or team tasks.
 */
export interface JackStep {
  tool: JackTool;
  title: string;
  status: 'started' | 'done' | 'failed' | 'skipped';
  detail: string;
  /** The document, image batch or team plan message, and (team) the tasks it made. */
  ref?: { id: string; taskIds?: string[] };
}
export const MESSAGE_STATUS = ['complete', 'streaming', 'stopped', 'failed', 'refused'] as const;

/** Messages live in their own collection so long chats stay fast to list and page. */
@Schema({ ...baseSchemaOptions, collection: 'messages' })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Chat', required: true }) chatId!: Types.ObjectId;
  @Prop({ type: String, required: true, enum: MESSAGE_ROLES }) role!: (typeof MESSAGE_ROLES)[number];
  @Prop({ type: String, default: '' }) content!: string;
  @Prop({ type: String, enum: MESSAGE_STATUS, default: 'complete' }) status!: (typeof MESSAGE_STATUS)[number];
  /** Which model actually answered (after Auto or a fallback) and what it cost. */
  @Prop({ type: String }) model?: string;
  @Prop({ type: String }) requestedModel?: string;
  @Prop({ type: Number, default: 0 }) credits!: number;
  @Prop({ type: Types.ObjectId, ref: 'UsageEvent' }) usageId?: Types.ObjectId;
  /** Files attached to a person's message (their text is read from the uploads collection). */
  @Prop({ type: [{ _id: false, fileId: Types.ObjectId, name: String, kind: String }], default: [] })
  attachments!: {
    fileId: Types.ObjectId;
    name: string;
    kind?: UploadKind;
  }[];
  /** Earlier versions after "regenerate". */
  @Prop({ type: [String], default: [] }) previousVersions!: string[];
  @Prop({ type: String, enum: ['up', 'down', null], default: null }) feedback?: 'up' | 'down' | null;
  /** Why an answer failed or wasn't sent (e.g. insufficient_credits); shown on the message. */
  @Prop({ type: { code: String, message: String }, default: null, _id: false }) error?: {
    code: string;
    message: string;
  } | null;
  /** "Auto" picked the model for this answer. */
  @Prop({ type: Boolean, default: false }) auto!: boolean;
  /** v2: what Jack started with his tools before answering (empty for a plain answer). */
  @Prop({ type: [Object], default: undefined }) plan?: JackStep[];
  /** v2: what Jack remembered from the person's message (shown under the answer, with Forget). */
  @Prop({ type: [Object], default: undefined }) learned?: { id: string; text: string }[];
}

export type MessageDocument = HydratedDocument<Message>;
export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ chatId: 1, createdAt: 1 });
MessageSchema.index({ workspaceId: 1, createdAt: -1 });
