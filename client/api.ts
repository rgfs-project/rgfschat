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
import type { SessionDto, UserDto } from '@shared/auth.ts';

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

/**
 * The CSRF token for the current session.
 *
 * Held in one place and attached by the single `request` wrapper below, so a
 * new call site cannot forget it — which would otherwise fail only at runtime,
 * only on state-changing requests.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const needsCsrf = method !== 'GET' && method !== 'HEAD';

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(needsCsrf && csrfToken !== null ? { 'X-CSRF-Token': csrfToken } : {}),
        ...init?.headers,
      },
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

export function editMessage(
  conversationId: string,
  messageId: string,
  body: string
): Promise<ConversationDetail> {
  return request<ConversationDetail>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
}

/**
 * Deletes a message and its paired reply.
 *
 * Resolves to `null` when that emptied the conversation, which the server then
 * deletes — the caller should drop it from the list rather than reopen it.
 */
export async function deleteMessage(
  conversationId: string,
  messageId: string
): Promise<ConversationDetail | null> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE', headers: { Accept: 'application/json', ...csrfHeader() } }
  );

  if (response.status === 204) return null;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw readErrorBody(body) ?? new ApiError('INTERNAL', 'Could not delete the message.');
  }
  return body as ConversationDetail;
}

export function regenerate(
  conversationId: string,
  model: string
): Promise<{ generationId: string; assistantMessageId: string }> {
  return request<{ generationId: string; assistantMessageId: string }>(
    '/api/generations/regenerate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, model }),
    }
  );
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

function csrfHeader(): Record<string, string> {
  return csrfToken === null ? {} : { 'X-CSRF-Token': csrfToken };
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: csrfHeader(),
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

// --- auth ---------------------------------------------------------------

export function fetchSession(): Promise<SessionDto> {
  return request<SessionDto>('/api/auth/session');
}

export function login(
  username: string,
  password: string
): Promise<{ user: UserDto; csrfToken: string }> {
  return request<{ user: UserDto; csrfToken: string }>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export function register(
  username: string,
  password: string
): Promise<{ user: UserDto; csrfToken: string }> {
  return request<{ user: UserDto; csrfToken: string }>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: csrfHeader() });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...csrfHeader() },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw readErrorBody(body) ?? new ApiError('INTERNAL', 'Could not change your password.');
  }
}
