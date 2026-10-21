import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Machine-readable error codes the frontend can switch on. Add new ones here. */
export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'rate_limited',
  'insufficient_credits',
  'upgrade_required',
  'model_unavailable',
  'service_unavailable',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ApiErrorBody {
  @ApiProperty({ enum: ERROR_CODES }) code!: ErrorCode;
  @ApiProperty({ description: 'Plain-language message that can be shown to the user' }) message!: string;
  @ApiProperty({ description: 'Quote this when reporting a problem' }) requestId!: string;
  @ApiPropertyOptional({
    description: 'Field-level problems for validation errors',
    type: 'object',
    additionalProperties: true,
  })
  details?: Record<string, unknown>;
}

/** Every error response has exactly this shape: { "error": { code, message, requestId, details? } }. */
export class ApiErrorResponse {
  @ApiProperty({ type: ApiErrorBody }) error!: ApiErrorBody;
}

/** Throw this from services for errors with a specific code (e.g. not enough credits). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
