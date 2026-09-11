import type { HealthDto } from '@shared/api.ts';
import { isErrorCode, type ErrorCode } from '@shared/errors.ts';

export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK';

  constructor(code: ErrorCode | 'NETWORK', message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** Narrows an unknown JSON body to the canonical error shape. */
function readErrorBody(body: unknown): ApiError | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;

  const { error } = body;
  if (typeof error !== 'object' || error === null) return null;

  const { code, message }: { code?: unknown; message?: unknown } = error;
  if (!isErrorCode(code) || typeof message !== 'string') return null;

  return new ApiError(code, message);
}

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('NETWORK', 'Could not reach the server.');
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw (
      readErrorBody(body) ?? new ApiError('INTERNAL', 'The server returned an unexpected error.')
    );
  }

  return body as T;
}

export function fetchHealth(): Promise<HealthDto> {
  return request<HealthDto>('/api/health');
}
