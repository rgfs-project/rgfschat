import type { HealthDto } from '@shared/api.ts';
import type { GenerationAcceptedDto, GenerationSnapshotDto } from '@shared/generation.ts';
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
  /**
   * The run currently streaming into this conversation, if any.
   *
   * Discovered from the server rather than remembered locally, so a reload in a
   * different tab — or after losing localStorage — still resumes it.
   */
  activeGenerationId: string | null;
}
import { isErrorCode, type ErrorCode } from '@shared/errors.ts';
import type { SamplerSettings } from '@shared/generation.ts';
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

/**
 * Notified once when the server rejects a request as unauthenticated.
 *
 * A session can expire at any moment, so *any* request may be the one that
 * discovers it. Handling that at each call site would mean every one of them
 * re-implementing the same transition, and a missed site would leave the app
 * showing a signed-in shell that can no longer do anything. Detecting it in
 * the one place every request already passes through makes that impossible.
 */
type AuthExpiredListener = () => void;
const authExpiredListeners = new Set<AuthExpiredListener>();

export function onAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => authExpiredListeners.delete(listener);
}

/**
 * Suppressed while the session itself is being fetched.
 *
 * `GET /api/session` answers "nobody is signed in" with a normal 200 and a
 * null user, but sign-in and sign-out probes can legitimately 401. Those are
 * answers, not expiries, and must not fire the transition.
 */
let suppressAuthExpiry = 0;

function notifyAuthExpired(): void {
  if (suppressAuthExpiry > 0) return;
  for (const listener of authExpiredListeners) listener();
}

/**
 * `{ signal }` only when there is one.
 *
 * Under `exactOptionalPropertyTypes` an explicit `signal: undefined` is not the
 * same as an absent one, and `RequestInit` will not accept it.
 */
function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal };
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
  } catch (cause) {
    // An abort is the data layer superseding this request, not a failure to
    // reach the server; surfacing it as one would show a spurious error.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('NETWORK', 'Could not reach the server.');
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error =
      readErrorBody(body) ?? new ApiError('INTERNAL', 'The server returned an unexpected error.');
    if (error.code === 'UNAUTHENTICATED') notifyAuthExpired();
    throw error;
  }

  return body as T;
}

export function fetchHealth(): Promise<HealthDto> {
  return request<HealthDto>('/api/health');
}

/** Models grouped by provider, with the flags the selector needs. */
export interface ProviderModelGroup {
  providerId: string;
  providerName: string;
  status: 'ready' | 'unavailable';
  /** The list is from an earlier successful fetch; the latest attempt failed. */
  stale: boolean;
  models: {
    id: string;
    inputModalities: string[];
    loaded: boolean;
    /** What the provider itself was launched with, where it reports it. */
    defaults?: SamplerSettings;
  }[];
}

export interface ModelCatalogue {
  providers: ProviderModelGroup[];
  /** The administrator's default, already checked against what is visible. */
  defaultModel: { providerId: string; modelId: string } | null;
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelCatalogue> {
  const body = await request<ModelCatalogue>('/api/models', signalInit(signal));
  return { providers: body.providers, defaultModel: body.defaultModel ?? null };
}

/**
 * The server assembles history from storage; only the new message is sent.
 * A model is identified by its `(providerId, model)` pair.
 */
export function startGeneration(
  conversationId: string,
  providerId: string,
  model: string,
  content: string
): Promise<GenerationAcceptedDto> {
  return request<GenerationAcceptedDto>('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, providerId, model, content }),
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
  providerId: string,
  model: string
): Promise<{ generationId: string; assistantMessageId: string }> {
  return request<{ generationId: string; assistantMessageId: string }>(
    '/api/generations/regenerate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, providerId, model }),
    }
  );
}

export async function listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
  const { conversations } = await request<{ conversations: ConversationSummary[] }>(
    '/api/conversations',
    signalInit(signal)
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

/**
 * `signal` is threaded through so the data layer can cancel a read that has
 * been superseded — opening conversation B while A is still in flight should
 * stop A, not merely ignore it once it arrives.
 */
export function getConversation(id: string, signal?: AbortSignal): Promise<ConversationDetail> {
  return request<ConversationDetail>(
    `/api/conversations/${encodeURIComponent(id)}`,
    signalInit(signal)
  );
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

export function generationStreamUrl(id: string, lastEventId?: number): string {
  const base = `/api/generations/${encodeURIComponent(id)}/stream`;
  // EventSource sets the Last-Event-ID header itself; the query parameter is
  // for callers that cannot set headers.
  return lastEventId === undefined ? base : `${base}?lastEventId=${lastEventId}`;
}

// --- auth ---------------------------------------------------------------

/** Runs `fn` without treating a 401 as the session expiring. */
export async function withoutAuthExpiry<T>(fn: () => Promise<T>): Promise<T> {
  suppressAuthExpiry += 1;
  try {
    return await fn();
  } finally {
    suppressAuthExpiry -= 1;
  }
}

export function fetchSession(signal?: AbortSignal): Promise<SessionDto> {
  // Answers "nobody is signed in" with a 200 and a null user, but a probe that
  // 401s here is still an answer rather than a session that just expired.
  return withoutAuthExpiry(() => request<SessionDto>('/api/auth/session', signalInit(signal)));
}

export function login(
  username: string,
  password: string
): Promise<{ user: UserDto; csrfToken: string }> {
  // A rejected credential is not an expiring session.
  return withoutAuthExpiry(() =>
    request<{ user: UserDto; csrfToken: string }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  );
}

export function register(
  username: string,
  password: string
): Promise<{ user: UserDto; csrfToken: string }> {
  return withoutAuthExpiry(() =>
    request<{ user: UserDto; csrfToken: string }>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  );
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

/* --- administration ------------------------------------------------------ */

export interface AdminUserDto extends UserDto {
  conversationCount: number;
}

export interface AdminProviderDto {
  id: string;
  name: string;
  kind: 'openai-compatible';
  baseUrl: string;
  /** INV-25: whether a key is set, never the key itself. */
  hasApiKey: boolean;
  timeoutMs: number;
  capabilities: { vision?: boolean; reasoning?: boolean };
  contextTokens?: number;
}

export interface StoredSampler {
  providerId: string;
  modelId: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  systemPrompt?: string;
}

export interface AdminSettingsDto {
  settings: {
    version: number;
    registrationMode?: 'open' | 'closed';
    defaultModel?: { providerId: string; modelId: string };
    hiddenModels?: { providerId: string; modelId: string }[];
    samplers?: StoredSampler[];
  };
  resolved: {
    registrationMode: 'open' | 'closed';
    defaultModel: { providerId: string; modelId: string } | null;
    hiddenModels: { providerId: string; modelId: string }[];
    samplers: StoredSampler[];
  };
}

export async function fetchAdminUsers(signal?: AbortSignal): Promise<AdminUserDto[]> {
  const { users } = await request<{ users: AdminUserDto[] }>(
    '/api/admin/users',
    signalInit(signal)
  );
  return users;
}

export function createAdminUser(body: {
  username: string;
  password: string;
  role?: 'user' | 'admin';
}): Promise<{ user: UserDto }> {
  return request('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function setAdminUserPassword(id: string, password: string): Promise<unknown> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export function updateAdminUser(
  id: string,
  changes: { role?: 'user' | 'admin'; status?: 'active' | 'disabled' }
): Promise<{ user: UserDto }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
}

export function deleteAdminUser(id: string, username: string): Promise<unknown> {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
}

export async function fetchAdminProviders(signal?: AbortSignal): Promise<AdminProviderDto[]> {
  const { providers } = await request<{ providers: AdminProviderDto[] }>(
    '/api/admin/providers',
    signalInit(signal)
  );
  return providers;
}

export interface ProviderWrite {
  id?: string;
  name: string;
  kind: 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: true;
  timeoutMs: number;
}

export function createAdminProvider(body: ProviderWrite): Promise<unknown> {
  return request('/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateAdminProvider(id: string, body: ProviderWrite): Promise<unknown> {
  return request(`/api/admin/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteAdminProvider(id: string): Promise<unknown> {
  return request(`/api/admin/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function testAdminProvider(body: {
  baseUrl: string;
  apiKey?: string;
}): Promise<{ ok: boolean; modelCount?: number; message?: string }> {
  return request('/api/admin/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function fetchAdminSettings(signal?: AbortSignal): Promise<AdminSettingsDto> {
  return request<AdminSettingsDto>('/api/admin/settings', signalInit(signal));
}

export function updateAdminSettings(body: {
  registrationMode?: 'open' | 'closed';
  /** `null` clears the configured default. */
  defaultModel?: { providerId: string; modelId: string } | null;
  hiddenModels?: { providerId: string; modelId: string }[];
}): Promise<AdminSettingsDto> {
  return request('/api/admin/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function refreshAdminModels(): Promise<unknown> {
  return request('/api/admin/models/refresh', { method: 'POST' });
}

export function rebuildAdminIndex(userId?: string): Promise<{ users: number }> {
  return request('/api/admin/maintenance/rebuild-index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userId === undefined ? {} : { userId }),
  });
}

export interface SamplerWrite {
  providerId: string;
  modelId: string;
  /** `null` clears the field, so the provider's own default applies again. */
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  minP?: number | null;
  repeatPenalty?: number | null;
  systemPrompt?: string | null;
}

export function updateAdminSampler(body: SamplerWrite): Promise<unknown> {
  return request('/api/admin/models/sampler', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Clears stored conversations. Omitting `withinHours` clears everything. */
export function clearAdminHistory(body: {
  userId?: string;
  withinHours?: 1 | 6 | 12 | 24;
}): Promise<{ deleted: number; cancelled: number }> {
  return request('/api/admin/maintenance/clear-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, confirm: true }),
  });
}
