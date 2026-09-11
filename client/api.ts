import type { HealthDto } from '@shared/api.ts';
import type {
  ChatMessage,
  GenerationAcceptedDto,
  GenerationSnapshotDto,
  ModelDto,
} from '@shared/generation.ts';
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    });
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

export async function fetchModels(): Promise<ModelDto[]> {
  const { models } = await request<{ models: ModelDto[] }>('/api/models');
  return models;
}

export function startGeneration(
  model: string,
  messages: ChatMessage[]
): Promise<GenerationAcceptedDto> {
  return request<GenerationAcceptedDto>('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
  });
}

export function fetchGeneration(id: string): Promise<GenerationSnapshotDto> {
  return request<GenerationSnapshotDto>(`/api/generations/${encodeURIComponent(id)}`);
}

export function cancelGeneration(id: string): Promise<GenerationSnapshotDto> {
  return request<GenerationSnapshotDto>(`/api/generations/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export function generationStreamUrl(id: string): string {
  return `/api/generations/${encodeURIComponent(id)}/stream`;
}
