import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const BROWSER_STATUS = [
  'running',
  'paused',
  'taken_over',
  'waiting',
  'done',
  'failed',
  'stopped',
] as const;
export type BrowserStatus = (typeof BROWSER_STATUS)[number];

export interface BrowserStep {
  at: Date;
  text: string;
  state: 'done' | 'working' | 'needs_you' | 'failed';
}

/** What the live view shows in sample mode (a drawing of the page Jack is on). */
export interface BrowserView {
  url: string;
  site: string;
  heading: string;
  fields: { label: string; value: string; active?: boolean }[];
  button?: string;
  note?: string;
}

/**
 * Jack working on a website in his own private browser (v2). Steps are what he did, the live view
 * shows where he is, and paying always waits for the person (a purchase action).
 */
@Schema({ ...baseSchemaOptions, collection: 'browser_tasks' })
export class BrowserTask {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true }) createdBy!: string;
  @Prop({ type: Types.ObjectId, ref: 'Chat', default: null }) chatId?: Types.ObjectId | null;
  @Prop({ type: String, required: true, maxlength: 2000 }) goal!: string;
  @Prop({ type: String, required: true, maxlength: 120 }) title!: string;
  @Prop({ type: String, enum: BROWSER_STATUS, default: 'running' }) status!: BrowserStatus;
  @Prop({ type: [Object], default: [] }) steps!: BrowserStep[];
  @Prop({ type: Object, default: null }) view?: BrowserView | null;
  /** Live view address from the browser service (null in sample mode). */
  @Prop({ type: String, default: null }) liveUrl?: string | null;
  @Prop({ type: String, default: '' }) providerRef!: string;
  /** Sample mode: which step of the script comes next. */
  @Prop({ type: Number, default: 0 }) cursor!: number;
  @Prop({ type: Types.ObjectId, ref: 'JackAction', default: null }) actionId?: Types.ObjectId | null;
  /** What Jack found or did, in a sentence, when finished. */
  @Prop({ type: String, default: '' }) summary!: string;
  /** The person's app theme: sites in the hosted browser are shown dark or light to match. */
  @Prop({ type: String, enum: ['light', 'dark'], default: 'light' }) scheme!: 'light' | 'dark';
}

export type BrowserTaskDocument = HydratedDocument<BrowserTask>;
export const BrowserTaskSchema = SchemaFactory.createForClass(BrowserTask);
BrowserTaskSchema.index({ workspaceId: 1, createdAt: -1 });
BrowserTaskSchema.index({ status: 1, updatedAt: 1 });
