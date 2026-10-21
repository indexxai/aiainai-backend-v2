import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types, type HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '../schema-options.js';

/** generating → done (all made) · partial (some failed or cancelled) · failed · blocked (refused). */
export const IMAGE_STATUS = ['generating', 'done', 'partial', 'failed', 'blocked'] as const;
export const IMAGE_ITEM_STATUS = ['waiting', 'done', 'failed', 'cancelled'] as const;
export const IMAGE_STYLES = ['photo', 'illustration', '3d', 'flat', 'none'] as const;
/**
 * generate: from a prompt (optionally with a reference image) · variations / edit / upscale /
 * cutout (background removed): made from one image of an earlier batch (`source`).
 */
export const IMAGE_KINDS = ['generate', 'variations', 'edit', 'upscale', 'cutout'] as const;
/** What a reference image guides: the look, the composition, or the subject. */
export const REFERENCE_USES = ['style', 'layout', 'subject'] as const;

/** One "Generate" request: prompt, settings and the images it produced. */
@Schema({ ...baseSchemaOptions, collection: 'image_generations' })
export class ImageGeneration {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true }) workspaceId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Project', default: null }) projectId?: Types.ObjectId | null;
  @Prop({ type: String, required: true }) createdBy!: string;
  /** Made by Jack in a conversation or by an AI Crews agent (Activity says who); unset: the person. */
  @Prop({ type: String, enum: ['jack', 'team'] }) madeBy?: 'jack' | 'team';
  @Prop({ type: String, required: true, maxlength: 4000 }) prompt!: string;
  /** Short title for the gallery (first words of the prompt). */
  @Prop({ type: String, default: '' }) title!: string;
  @Prop({ type: String, default: '' }) negative!: string;
  /** Requested ('auto' or a key) and the model that drew it. */
  @Prop({ type: String, required: true, default: 'auto' }) requestedModel!: string;
  @Prop({ type: String }) model?: string;
  @Prop({ type: Boolean, default: false }) auto!: boolean;
  @Prop({ type: String, required: true, default: '1:1' }) ratio!: string;
  @Prop({ type: Number, required: true, min: 1, max: 4, default: 1 }) count!: number;
  @Prop({ type: Boolean, default: false }) hd!: boolean;
  @Prop({ type: String, enum: IMAGE_STYLES, default: 'none' }) style!: (typeof IMAGE_STYLES)[number];
  @Prop({ type: String, enum: IMAGE_STATUS, default: 'generating' }) status!: (typeof IMAGE_STATUS)[number];
  @Prop({ type: String, enum: IMAGE_KINDS, default: 'generate' }) kind!: (typeof IMAGE_KINDS)[number];
  @Prop({ type: { id: Types.ObjectId, index: Number }, default: null, _id: false }) source?: {
    id: Types.ObjectId;
    index: number;
  } | null;
  @Prop({
    type: { key: String, name: String, use: { type: String, enum: REFERENCE_USES } },
    default: null,
    _id: false,
  })
  reference?: { key: string; name: string; use: (typeof REFERENCE_USES)[number] } | null;
  @Prop({
    type: [
      {
        status: { type: String, enum: IMAGE_ITEM_STATUS },
        key: String,
        thumbKey: String,
        width: Number,
        height: Number,
        mediaType: String,
        bytes: Number,
      },
    ],
    default: [],
    _id: false,
  })
  images!: {
    status: (typeof IMAGE_ITEM_STATUS)[number];
    key?: string;
    thumbKey?: string;
    width?: number;
    height?: number;
    mediaType?: string;
    bytes?: number;
  }[];
  @Prop({ type: Number, default: 0 }) credits!: number;
  /** The credit hold for this batch, so an interrupted batch can be released. */
  @Prop({ type: String }) holdId?: string;
  /** Set by Cancel; checked before each image (works across servers). */
  @Prop({ type: Boolean, default: false }) cancelRequested!: boolean;
  @Prop({ type: { code: String, message: String }, default: null, _id: false }) error?: {
    code: string;
    message: string;
  } | null;
  @Prop({ type: Date, default: null }) deletedAt?: Date | null;
}

export type ImageGenerationDocument = HydratedDocument<ImageGeneration>;
export const ImageGenerationSchema = SchemaFactory.createForClass(ImageGeneration);
ImageGenerationSchema.index({ workspaceId: 1, deletedAt: 1, createdAt: -1 });
ImageGenerationSchema.index({ status: 1, updatedAt: 1 });
