import type { SchemaOptions } from '@nestjs/mongoose';

/**
 * Options every collection uses:
 * - createdAt / updatedAt maintained automatically
 * - no __v version key in API output
 * - `id` (string) instead of `_id` when converted to JSON
 */
export const baseSchemaOptions: SchemaOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    virtuals: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = String(ret._id);
      delete ret._id;
      return ret;
    },
  },
};

/** Soft-deleted records stay restorable for this long, then a cleanup job removes them. */
export const SOFT_DELETE_RETENTION_DAYS = 30;
