import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ApiErrorResponse, type ErrorCode } from './api-error.js';
import { REQUEST_ID_HEADER } from './request-id.js';

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'validation_failed',
  429: 'rate_limited',
  503: 'service_unavailable',
};

const SAFE_MESSAGE: Record<ErrorCode, string> = {
  bad_request: 'The request was not valid.',
  validation_failed: 'Some fields need fixing.',
  unauthorized: 'Please sign in to continue.',
  forbidden: 'You don’t have access to this.',
  not_found: 'We can’t find that.',
  conflict: 'This was changed by someone else. Refresh and try again.',
  payload_too_large: 'That file or request is too large.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  insufficient_credits: 'You don’t have enough credits for this.',
  upgrade_required: 'This needs the Jack Personal plan.',
  model_unavailable: 'That model isn’t available right now. Try Auto or another model.',
  service_unavailable: 'This is temporarily unavailable. Please try again shortly.',
  internal_error: 'Something went wrong on our side. Your work is saved; please try again.',
};

/** Errors from express middleware (body-parser, http-errors) that are safe to answer with their 4xx. */
function isClientHttpError(e: unknown): e is { status: number; type?: string } {
  if (!e || typeof e !== 'object' || e instanceof HttpException || e instanceof AppError) return false;
  const status = (e as { status?: unknown }).status;
  return (
    typeof status === 'number' && status >= 400 && status < 500 && (e as { expose?: unknown }).expose === true
  );
}

/**
 * Turns every thrown error into the standard error shape. Unexpected errors are logged with
 * their stack and the request ID, but the response never leaks internal details.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const requestId = String(req.id ?? res.getHeader(REQUEST_ID_HEADER) ?? 'unknown');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'internal_error';
    let message = SAFE_MESSAGE.internal_error;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (isClientHttpError(exception)) {
      // Body parser errors (too large, broken JSON) carry their own 4xx status.
      status = exception.status;
      code = CODE_BY_STATUS[status] ?? 'bad_request';
      message =
        exception.type === 'entity.parse.failed' ? 'The request body isn’t valid JSON.' : SAFE_MESSAGE[code];
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
      const body = exception.getResponse();
      // Nest's own 4xx messages are safe to show (e.g. validation messages); 5xx are not.
      const raw =
        typeof body === 'object' && body && 'message' in body ? (body as { message: unknown }).message : body;
      if (status < 500 && Array.isArray(raw)) {
        code = 'validation_failed';
        message = SAFE_MESSAGE.validation_failed;
        details = { problems: raw };
      } else if (status < 500 && typeof raw === 'string' && raw) {
        message = raw;
      } else {
        message = SAFE_MESSAGE[code];
      }
    }

    if (status >= 500) {
      this.logger.error(
        {
          requestId,
          err:
            exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception,
        },
        'Unhandled error',
      );
    }

    const payload: ApiErrorResponse = {
      error: { code, message, requestId, ...(details ? { details } : {}) },
    };
    res.status(status).json(payload);
  }
}
