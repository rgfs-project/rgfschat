import { ERROR_STATUS, type ErrorCode } from '@shared/errors.ts';

/**
 * The only error type routes throw deliberately.
 *
 * Anything else that escapes a handler is mapped to `INTERNAL` by the error
 * middleware, with no internals exposed (INV-01).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options.details;
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('VALIDATION', message, details !== undefined ? { details } : {});
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError('NOT_FOUND', message);
  }

  static payloadTooLarge(message = 'Request body is too large'): AppError {
    return new AppError('PAYLOAD_TOO_LARGE', message);
  }

  static internal(message = 'Internal server error', cause?: unknown): AppError {
    return new AppError('INTERNAL', message, cause !== undefined ? { cause } : {});
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
