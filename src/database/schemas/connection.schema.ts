import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const CONNECTION_APPS = ['gmail', 'google-calendar', 'google-drive', 'slack'] as const;
export type ConnectionApp = (typeof CONNECTION_APPS)[number];

/** How much Jack may do in an app: read only · write drafts · act after asking · act on his own. */
export const ACCESS_LEVELS = ['read', 'draft', 'ask', 'auto'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** An app connected to one space (Personal and Business connect their own accounts). */
@Schema({ ...baseSchemaOptions, collection: 'connections' })
export class Connection {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, required: true }) createdBy!: string;
  @Prop({ type: String, required: true, enum: CONNECTION_APPS }) app!: ConnectionApp;
  /** pending: sent to the app's sign-in page · connected · failed: sign-in didn't finish or access was removed */
  @Prop({ type: String, enum: ['pending', 'connected', 'failed'], default: 'pending' }) status!:
    'pending' | 'connected' | 'failed';
  @Prop({ type: String, enum: ACCESS_LEVELS, default: 'ask' }) level!: AccessLevel;
  /** The connector service's id for this account (Composio connected account). */
  @Prop({ type: String, default: '' }) providerRef!: string;
  /** The signed-in account, e.g. an email address, when the app tells us. */
  @Prop({ type: String, default: '' }) account!: string;
  @Prop({ type: Date, default: null }) connectedAt?: Date | null;
}

export type ConnectionDocument = HydratedDocument<Connection>;
export const ConnectionSchema = SchemaFactory.createForClass(Connection);
ConnectionSchema.index({ workspaceId: 1, app: 1 }, { unique: true });
