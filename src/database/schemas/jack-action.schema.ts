import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const JACK_ACTION_KINDS = ['purchase', 'send_email', 'calendar_event', 'slack_message'] as const;
export type JackActionKind = (typeof JACK_ACTION_KINDS)[number];

export interface PurchasePayload {
  item: string;
  seller: string;
  site: string;
  amount: number;
  currency: string;
}
export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}
export interface SlackPayload {
  /** Channel name without the #. */
  channel: string;
  text: string;
}
export interface EventPayload {
  title: string;
  start: string;
  minutes: number;
}

/**
 * Something Jack wants to do that needs the person's OK first: pay, send an email, add a
 * calendar event. Shown in Approvals and in the conversation; nothing happens until approved.
 */
@Schema({ ...baseSchemaOptions, collection: 'jack_actions' })
export class JackAction {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true }) createdBy!: string;
  @Prop({ type: String, required: true, enum: JACK_ACTION_KINDS }) kind!: JackActionKind;
  @Prop({ type: String, required: true, maxlength: 200 }) title!: string;
  @Prop({ type: Object, required: true }) payload!:
    PurchasePayload | EmailPayload | EventPayload | SlackPayload;
  /** The conversation (and answer) it came from, and the browser task for a purchase. */
  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null }) chatId?: Types.ObjectId | null;
  @Prop({ type: Types.ObjectId, ref: 'BrowserTask', default: null }) browserTaskId?: Types.ObjectId | null;
  /** pending → approved → done | failed; or rejected; or cancelled (the task was stopped). */
  @Prop({
    type: String,
    enum: ['pending', 'done', 'failed', 'rejected', 'cancelled'],
    default: 'pending',
  })
  status!: 'pending' | 'done' | 'failed' | 'rejected' | 'cancelled';
  /** What happened, in one line ("Paid with a one-time card ending 4821"). */
  @Prop({ type: String, default: '' }) result!: string;
  @Prop({ type: String, default: '' }) note!: string;
  @Prop({ type: Date, default: null }) decidedAt?: Date | null;
}

export type JackActionDocument = HydratedDocument<JackAction>;
export const JackActionSchema = SchemaFactory.createForClass(JackAction);
JackActionSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
