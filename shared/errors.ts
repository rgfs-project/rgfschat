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
  // Phase 5
  'PROVIDER_NOT_FOUND',
  'ENDPOINT_NOT_ALLOWED',
  // Phase 9
  'LAST_ADMIN',
  // Phase 11
  'UNSUPPORTED_MEDIA_TYPE',
  'QUOTA_EXCEEDED',
  'MODEL_CAPABILITY_UNSUPPORTED',
  // Phase 12
  'RATE_LIMITED',
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
  PROVIDER_NOT_FOUND: 400,
  ENDPOINT_NOT_ALLOWED: 400,
  // A conflict with the state of the system, not a malformed request: the
  // instance must keep at least one way in.
  LAST_ADMIN: 409,
  // The bytes are not something this application will store. 415 rather than
  // 400: the request was well-formed, its payload was the problem.
  UNSUPPORTED_MEDIA_TYPE: 415,
  // Refused for size, like PAYLOAD_TOO_LARGE, but about the total already
  // stored rather than about this one request.
  QUOTA_EXCEEDED: 413,
  // The request is valid and the model cannot do it — an unprocessable
  // entity rather than a bad one.
  MODEL_CAPABILITY_UNSUPPORTED: 422,
  // Accompanied by `Retry-After`, so the caller is told when to return rather
  // than left to retry into the same wall.
  RATE_LIMITED: 429,
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
