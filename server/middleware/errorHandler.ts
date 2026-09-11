import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorCode, ErrorResponse } from '@shared/errors.ts';
import { ERROR_STATUS } from '@shared/errors.ts';
import { AppError, isAppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';

/** Builds the canonical error body. This is the only place one is constructed. */
export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): ErrorResponse {
  const error: ErrorResponse['error'] = { code, message };
  if (details !== undefined && Object.keys(details).length > 0) {
    error.details = details;
  }
  return { error };
}

/** Express's body-parser errors carry `type` and `status`; neither is on the base Error type. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Translates known infrastructure errors into `AppError`.
 * Anything unrecognized returns `null` and becomes `INTERNAL`.
 */
function translate(err: unknown): AppError | null {
  if (isAppError(err)) return err;

  if (err instanceof Error) {
    const candidate = err as BodyParserError;
    const status = candidate.status ?? candidate.statusCode;

    if (candidate.type === 'entity.too.large' || status === 413) {
      return AppError.payloadTooLarge();
    }
    if (candidate.type === 'entity.parse.failed' || (status === 400 && 'body' in candidate)) {
      return AppError.validation('Request body is not valid JSON');
    }
  }

  return null;
}

/** Terminal 404 for unmatched routes. Mounted after every router. */
export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => {
    next(AppError.notFound('Route not found'));
  };
}

/**
 * The single error boundary (INV-01).
 *
 * Every failure leaves through here in the canonical shape. Unhandled errors
 * become `INTERNAL` with a fixed message: no stack traces, paths, upstream
 * bodies, or secrets reach the client (INV-03).
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    // Express 5 delegates to the default handler once headers are sent.
    if (res.headersSent) {
      next(err);
      return;
    }

    const appError = translate(err);

    if (appError === null) {
      logger.error('Unhandled error', {
        method: req.method,
        path: req.path,
        error: err instanceof Error ? err : { message: String(err) },
      });
      res.status(ERROR_STATUS.INTERNAL).json(errorBody('INTERNAL', 'Internal server error'));
      return;
    }

    if (appError.status >= 500) {
      logger.error('Request failed', {
        method: req.method,
        path: req.path,
        code: appError.code,
        error: appError,
      });
    } else {
      logger.warn('Request rejected', {
        method: req.method,
        path: req.path,
        code: appError.code,
      });
    }

    res.status(appError.status).json(errorBody(appError.code, appError.message, appError.details));
  };
}
