import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from './api-error.js';

/** Validates a request body or query with zod; problems come back as `validation_failed` with per-field details. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
  throw new AppError('validation_failed', 'Some fields need fixing.', HttpStatus.UNPROCESSABLE_ENTITY, {
    fields,
  });
}
