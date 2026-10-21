import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

export const THEMES = ['system', 'dark', 'light'] as const;

/** `onboarding.use` for a new account that hasn't picked Personal or Business yet. */
export const ONBOARDING_PENDING = 'pending';

/**
 * aiainai-specific profile. Sign-in data (user, sessions, sign-in methods, verification codes)
 * lives in Better Auth's own collections; this links to it by `userId`.
 */
@Schema({ ...baseSchemaOptions, collection: 'user_profiles' })
export class UserProfile {
  @Prop({ type: String, required: true, unique: true }) userId!: string;
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: String, enum: THEMES, default: 'dark' }) theme!: (typeof THEMES)[number];
  /** Default text model for new messages: a model key, or "auto". Set in Settings and the model menu. */
  @Prop({ type: String, default: 'auto' }) textModel!: string;
  /**
   * Answers from onboarding. `use` is what the person picked on the sign-up screen "What will
   * you use Jack for?": 'personal' or 'business', or 'pending' until they answer. Accounts made
   * before that screen existed have no `use` and are never asked.
   */
  @Prop({ type: Object, default: {} }) onboarding!: Record<string, string>;
  /** Features the person asked to hear about when they launch (e.g. "captain-jack"). */
  @Prop({ type: [String], default: [] }) waitlist!: string[];
  /**
   * Reserved for linking an indexx account later ("Continue with indexx", OpenID Connect).
   * Unique when set, so one indexx account maps to one aiainai account.
   */
  @Prop({ type: String }) indexxAccountId?: string;
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type UserProfileDocument = HydratedDocument<UserProfile>;
export const UserProfileSchema = SchemaFactory.createForClass(UserProfile);
UserProfileSchema.index({ indexxAccountId: 1 }, { unique: true, sparse: true });
