/**
 * Canonical error contract (contracts §5).
 *
 * The full code table is defined in `.Phases/00-contracts.md`. Each phase adds
 * only the codes it actually uses; Phase 1 introduces the four below.
 */
export const ERROR_CODES = ['VALIDATION', 'NOT_FOUND', 'PAYLOAD_TOO_LARGE', 'INTERNAL'] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status paired with each code. Mapping is explicit, never inferred. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
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
