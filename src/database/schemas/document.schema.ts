import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const DOC_TYPES = [
  'proposal',
  'report',
  'plan',
  'meeting-notes',
  'letter',
  'article',
  'other',
] as const;
export const DOC_LENGTHS = ['short', 'medium', 'long'] as const;
export const DOC_TONES = ['professional', 'friendly', 'persuasive'] as const;
/** draft: outline saved, not written yet · writing · stopped part-way · failed · ready */
export const DOC_STATUS = ['draft', 'writing', 'stopped', 'failed', 'ready'] as const;
/** Anyone with the link: nothing, or read-only. */
export const LINK_ACCESS = ['off', 'view'] as const;

export interface DocInvite {
  email: string;
  invitedAt: Date;
  invitedBy: string;
}

/**
 * An AI Docs document. The AI writes Markdown (`markdown`); once someone edits it, the editor's
 * JSON (`content`) is the source of truth and `text` is kept in sync for search and word count.
 * Versions arrive in a later milestone. Sharing is read-only (link or invite).
 */
@Schema({ ...baseSchemaOptions, collection: 'documents' })
export class DocumentRecord {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Project', default: null }) projectId?: Types.ObjectId | null;
  @Prop({ type: String, required: true }) createdBy!: string;
  /** Made by Jack in a conversation or by an AI Crews agent (Activity says who); unset: the person. */
  @Prop({ type: String, enum: ['jack', 'team'] }) madeBy?: 'jack' | 'team';
  @Prop({ type: String, required: true, trim: true, maxlength: 200 }) title!: string;
  @Prop({ type: String, enum: DOC_TYPES, default: 'other' }) type!: (typeof DOC_TYPES)[number];
  /** What the person asked for, and the outline they approved. */
  @Prop({ type: String, default: '', maxlength: 4000 }) brief!: string;
  @Prop({ type: [{ heading: String, note: String }], default: [], _id: false }) outline!: {
    heading: string;
    note: string;
  }[];
  @Prop({ type: String, enum: DOC_LENGTHS, default: 'medium' }) length!: (typeof DOC_LENGTHS)[number];
  @Prop({ type: String, enum: DOC_TONES, default: 'professional' }) tone!: (typeof DOC_TONES)[number];
  /** Model requested ('auto' or a key), the one that wrote it, and what writing cost. */
  @Prop({ type: String, default: 'auto' }) requestedModel!: string;
  @Prop({ type: String }) model?: string;
  @Prop({ type: Boolean, default: false }) auto!: boolean;
  @Prop({ type: Number, default: 0 }) credits!: number;
  @Prop({ type: { code: String, message: String }, default: null, _id: false }) error?: {
    code: string;
    message: string;
  } | null;
  /** The AI's draft. */
  @Prop({ type: String, default: '' }) markdown!: string;
  @Prop({ type: Object, default: null }) content?: Record<string, unknown> | null;
  /** Plain text copy for search and word count. */
  @Prop({ type: String, default: '' }) text!: string;
  @Prop({ type: Number, default: 0 }) wordCount!: number;
  @Prop({ type: String, enum: DOC_STATUS, default: 'draft' }) status!: (typeof DOC_STATUS)[number];
  /** Sharing: a read-only public link (random token) and people invited by email (view only). */
  @Prop({ type: String, enum: LINK_ACCESS, default: 'off' }) linkAccess!: (typeof LINK_ACCESS)[number];
  @Prop({ type: String, default: null }) shareToken?: string | null;
  @Prop({
    type: [{ email: String, invitedAt: Date, invitedBy: String }],
    default: [],
    _id: false,
  })
  invites!: DocInvite[];
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type DocumentRecordDocument = HydratedDocument<DocumentRecord>;
export const DocumentRecordSchema = SchemaFactory.createForClass(DocumentRecord);
DocumentRecordSchema.index({ workspaceId: 1, deletedAt: 1, updatedAt: -1 });
DocumentRecordSchema.index({ workspaceId: 1, title: 'text', text: 'text' });
DocumentRecordSchema.index(
  { shareToken: 1 },
  { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } },
);
DocumentRecordSchema.index({ 'invites.email': 1, deletedAt: 1, updatedAt: -1 });
