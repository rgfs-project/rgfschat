import type { HealthDto } from '@shared/api.ts';
import type { GenerationAcceptedDto, GenerationSnapshotDto, ModelDto } from '@shared/generation.ts';
import type { Message } from '@shared/conversation.ts';

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  malformed: boolean;
}

export interface ConversationDetail {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}
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

/** The server assembles history from storage; only the new message is sent. */
export function startGeneration(
  conversationId: string,
  model: string,
  content: string
): Promise<GenerationAcceptedDto> {
  return request<GenerationAcceptedDto>('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, model, content }),
  });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const { conversations } = await request<{ conversations: ConversationSummary[] }>(
    '/api/conversations'
  );
  return conversations;
}

export function createConversation(): Promise<ConversationDetail> {
  return request<ConversationDetail>('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`);
}

export function renameConversation(id: string, title: string): Promise<ConversationDetail> {
  return request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new ApiError('INTERNAL', 'Could not delete the conversation.');
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
