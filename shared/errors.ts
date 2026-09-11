/**
 * Canonical error contract (contracts §5).
 *
 * The full code table is defined in the project contract (§5). Each phase adds
 * only the codes it actually uses; Phase 1 introduces the four below.
 */
export const ERROR_CODES = [
  // Phase 1
  'VALIDATION',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
  // Phase 2
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'MODEL_NOT_FOUND',
  'GENERATION_NOT_FOUND',
  // Phase 3
  'CONVERSATION_MALFORMED',
  'GENERATION_IN_PROGRESS',
  'CONTEXT_TOO_LARGE',
  // Phase 4
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CSRF_INVALID',
  'CONFLICT',
  'REGISTRATION_CLOSED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status paired with each code. Mapping is explicit, never inferred. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  MODEL_NOT_FOUND: 400,
  GENERATION_NOT_FOUND: 404,
  CONVERSATION_MALFORMED: 422,
  GENERATION_IN_PROGRESS: 409,
  CONTEXT_TOO_LARGE: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  CONFLICT: 409,
  REGISTRATION_CLOSED: 403,
};

/**
 * The only error body the API ever emits.
 *
 * `details` is optional and never contains stack traces, paths, upstream
 * bodies, or secrets (INV-01, INV-03).
 */
export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
