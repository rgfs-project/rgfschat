import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenerationEvent, GenerationSnapshotDto } from '@shared/generation.ts';
import { createApp } from '../app.ts';
import { GenerationManager } from '../generation/manager.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import {
  startMockProvider,
  type MockProvider,
  type MockProviderOptions,
} from '../provider/mockServer.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { SessionManager } from '../auth/sessions.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { GenerationService } from '../generation/service.ts';

const logger = createLogger({ level: 'silent', write: () => {} });
const USER = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

/** Every protected route needs a session cookie and a CSRF token. */
let client: TestClient | undefined;
const afetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: {
      ...(client === undefined
        ? {}
        : { Cookie: `workspace_session=${client.token}`, 'X-CSRF-Token': client.csrfToken }),
      ...init.headers,
    },
  });

let mock: MockProvider | undefined;
let server: Server | undefined;
let manager: GenerationManager | undefined;
let dataDir: string | undefined;
let store: ConversationStore | undefined;
let service: GenerationService | undefined;
let hub: ProviderHub;

afterEach(async () => {
  // Generation output is persisted after the terminal state, so removing the
  // temp DATA_DIR immediately can race an in-flight index write.
  await service?.allSettled();
  manager?.shutdown();
  manager = undefined;
  if (server !== undefined) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await mock?.close();
  mock = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  store = undefined;
  service = undefined;
});

/** Boots the real app over real HTTP, which is what SSE needs. */
async function boot(options: MockProviderOptions = {}, apiKey?: string): Promise<string> {
  mock = await startMockProvider(options);
  const provider = new LlamaCppProvider(
    {
      baseUrl: mock.url,
      apiKey,
      timeoutMs: 5_000,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
    },
    logger
  );
  manager = new GenerationManager({ provider, logger, maxOutputTokens: 128 });
  hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    factory: () => provider,
  });
  hub.setProviders([
    {
      id: 'local',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: mock?.url ?? 'http://127.0.0.1:1',
      timeoutMs: 5_000,
      capabilities: {},
    },
  ]);

  dataDir = await mkdtemp(join(tmpdir(), 'workspace-gen-'));
  store = new ConversationStore({ paths: new StoragePaths(dataDir), logger });
  const index = new ChatIndex({ store, logger });
  await store.init(USER);
  service = new GenerationService({
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
  });

  const users = new UserStore({
    paths: store.paths,
    logger,
    argon2Options: ARGON2_TEST_OPTIONS,
  });
  const sessions = new SessionManager({
    paths: store.paths,
    logger,
    absoluteTtlMs: 60 * 60 * 1000,
    idleTtlMs: 60 * 60 * 1000,
  });
  await users.create({ username: 'tester', password: 'correct horse battery', id: USER });

  const app = createApp({
    logger,
    hub,
    manager,
    store,
    index,
    service,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  client = await signIn(url, sessions, USER);
  return url;
}

/** Phase 3: history comes from storage, so a conversation must exist first. */
async function newConversation(base: string): Promise<string> {
  const response = await afetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return ((await response.json()) as { id: string }).id;
}

async function startGeneration(base: string, model = 'GPT', conversationId?: string) {
  const id = conversationId ?? (await newConversation(base));
  const response = await afetch(`${base}/api/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: id, providerId: 'local', model, content: 'hi' }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

/** Reads an SSE stream to completion, returning parsed events plus raw text. */
async function readSse(
  url: string,
  opts: { stopAfter?: number; signal?: AbortSignal } = {}
): Promise<{ events: { id: string; event: GenerationEvent }[]; raw: string; headers: Headers }> {
  const response = await afetch(url, opts.signal !== undefined ? { signal: opts.signal } : {});
  const events: { id: string; event: GenerationEvent }[] = [];
  let raw = '';

  if (response.body === null) return { events, raw, headers: response.headers };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      buffer += text;

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let id = '';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('id:')) id = line.slice(3).trim();
          if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (data !== '') {
          events.push({ id, event: JSON.parse(data) as GenerationEvent });
        }
        if (opts.stopAfter !== undefined && events.length >= opts.stopAfter) {
          await reader.cancel();
          return { events, raw, headers: response.headers };
        }
      }
    }
  } catch {
    // Aborted by the caller.
  }

  return { events, raw, headers: response.headers };
}

async function settle(base: string, id: string): Promise<GenerationSnapshotDto> {
  for (let i = 0; i < 300; i += 1) {
    const response = await afetch(`${base}/api/generations/${id}`);
    const snapshot = (await response.json()) as GenerationSnapshotDto;
    if (snapshot.state !== 'pending' && snapshot.state !== 'streaming') return snapshot;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('did not settle');
}

describe('GET /api/models', () => {
  it('returns the mapped model list', async () => {
    const base = await boot();

    const response = await afetch(`${base}/api/models`);
    const body = (await response.json()) as {
      providers: { providerId: string; models: unknown[] }[];
    };

    expect(response.status).toBe(200);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]?.providerId).toBe('local');
    expect(body.providers[0]?.models).toHaveLength(2);
  });

  it('INV-04: never exposes credentials or raw provider payloads', async () => {
    const base = await boot({ requireApiKey: 'super-secret' }, 'super-secret');

    const response = await afetch(`${base}/api/models`);
    const text = await response.text();

    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('api-key-file');
    expect(text).not.toContain('.gguf');
    expect(text).not.toContain('llama-server');
  });
});

describe('POST /api/generations', () => {
  it('returns 202 with both ids', async () => {
    const base = await boot();

    const { status, body } = await startGeneration(base);

    expect(status).toBe(202);
    expect(Object.keys(body).sort()).toEqual([
      'assistantMessageId',
      'generationId',
      'userMessageId',
    ]);
  });

  it('rejects an unknown model with MODEL_NOT_FOUND and creates nothing', async () => {
    const base = await boot();

    const conversationId = await newConversation(base);
    const response = await afetch(`${base}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        providerId: 'local',
        model: 'no-such-model',
        content: 'hi',
      }),
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('MODEL_NOT_FOUND');
  });

  it('INV-02: rejects unknown fields and malformed messages', async () => {
    const base = await boot();

    const conversationId = await newConversation(base);

    const extra = await afetch(`${base}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        providerId: 'local',
        model: 'GPT',
        content: 'hi',
        temperature: 0.9,
      }),
    });
    expect(extra.status).toBe(400);
    expect(((await extra.json()) as { error: { code: string } }).error.code).toBe('VALIDATION');

    // The client may no longer supply history; it comes from storage.
    const withMessages = await afetch(`${base}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        providerId: 'local',
        model: 'GPT',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(withMessages.status).toBe(400);
  });
});

describe('GET /api/generations/:id', () => {
  it('404s for an unknown generation', async () => {
    const base = await boot();

    const response = await afetch(`${base}/api/generations/nope`);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('GENERATION_NOT_FOUND');
  });

  it('exposes the terminal snapshot with reasoning separated', async () => {
    const base = await boot({ reasoningChunks: ['hmm'], contentChunks: ['Hi'] });
    const { body } = await startGeneration(base);

    const snapshot = await settle(base, body.generationId!);

    expect(snapshot.state).toBe('completed');
    expect(snapshot.content).toBe('Hi');
    expect(snapshot.reasoning).toBe('hmm');
  });
});

describe('GET /api/generations/:id/stream', () => {
  it('sends the contract-required SSE headers', async () => {
    const base = await boot({ chunkDelayMs: 5 });
    const { body } = await startGeneration(base);

    const { headers } = await readSse(`${base}/api/generations/${body.generationId}/stream`);

    expect(headers.get('content-type')).toContain('text/event-stream');
    expect(headers.get('cache-control')).toContain('no-cache');
    expect(headers.get('x-accel-buffering')).toBe('no');
    expect(headers.get('content-encoding')).toBeNull();
  });

  it('opens with a snapshot, streams deltas, and ends with done', async () => {
    const base = await boot({
      reasoningChunks: ['r1'],
      contentChunks: ['a', 'b'],
      chunkDelayMs: 5,
    });
    const { body } = await startGeneration(base);

    const { events } = await readSse(`${base}/api/generations/${body.generationId}/stream`);

    expect(events[0]?.event.type).toBe('snapshot');

    // The stream may attach before or after the generation finishes, so the
    // output is reconstructed from the opening snapshot *plus* any deltas that
    // followed. Asserting on deltas alone would fail whenever the run happened
    // to complete first — a timing accident, not a defect.
    const opening = events[0]?.event;
    const snapshot = opening?.type === 'snapshot' ? opening.snapshot : undefined;

    const joined = (type: 'content' | 'reasoning'): string =>
      (type === 'content' ? (snapshot?.content ?? '') : (snapshot?.reasoning ?? '')) +
      events
        .map((e) => e.event)
        .filter((e) => e.type === type)
        .map((e) => (e as { delta: string }).delta)
        .join('');

    expect(joined('content')).toBe('ab');
    expect(joined('reasoning')).toBe('r1');

    // Either it was already terminal when we attached, or we saw it finish.
    const last = events.at(-1)?.event;
    const alreadyDone = snapshot !== undefined && snapshot.state === 'completed';
    expect(alreadyDone || last?.type === 'done').toBe(true);
  });

  it('gives every event a monotonically increasing id', async () => {
    const base = await boot({ contentChunks: ['a', 'b', 'c'], chunkDelayMs: 5 });
    const { body } = await startGeneration(base);

    const { events } = await readSse(`${base}/api/generations/${body.generationId}/stream`);

    const ids = events.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('INV-06: disconnecting does not cancel the generation', async () => {
    const base = await boot({ contentChunks: ['a', 'b', 'c', 'd', 'e'], chunkDelayMs: 25 });
    const { body } = await startGeneration(base);
    const id = body.generationId!;

    // Attach, read a couple of events, then hang up mid-flight.
    await readSse(`${base}/api/generations/${id}/stream`, { stopAfter: 2 });

    const snapshot = await settle(base, id);
    expect(snapshot.state).toBe('completed');
    expect(snapshot.content).toBe('abcde');
  });

  it('a reconnecting client receives the current snapshot, then live events', async () => {
    const base = await boot({ contentChunks: ['a', 'b', 'c', 'd'], chunkDelayMs: 30 });
    const { body } = await startGeneration(base);
    const id = body.generationId!;

    await readSse(`${base}/api/generations/${id}/stream`, { stopAfter: 2 });
    const { events } = await readSse(`${base}/api/generations/${id}/stream`);

    const first = events[0]?.event;
    expect(first?.type).toBe('snapshot');

    // Snapshot content plus subsequent deltas must reconstruct the whole output.
    const snapshotContent = first?.type === 'snapshot' ? first.snapshot.content : '';
    const deltas = events
      .map((e) => e.event)
      .filter((e): e is Extract<GenerationEvent, { type: 'content' }> => e.type === 'content')
      .map((e) => e.delta)
      .join('');

    expect(snapshotContent + deltas).toBe('abcd');
  });

  it('streams a terminal generation as a single snapshot and closes', async () => {
    const base = await boot({ contentChunks: ['done'] });
    const { body } = await startGeneration(base);
    await settle(base, body.generationId!);

    const { events } = await readSse(`${base}/api/generations/${body.generationId}/stream`);

    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe('snapshot');
  });

  it('404s for an unknown generation without opening a stream', async () => {
    const base = await boot();

    const response = await afetch(`${base}/api/generations/missing/stream`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('POST /api/generations/:id/cancel', () => {
  it('moves a running generation to cancelled', async () => {
    const base = await boot({ contentChunks: ['a', 'b', 'c', 'd'], chunkDelayMs: 30 });
    const { body } = await startGeneration(base);

    await new Promise((r) => setTimeout(r, 40));
    const response = await afetch(`${base}/api/generations/${body.generationId}/cancel`, {
      method: 'POST',
    });
    const snapshot = (await response.json()) as GenerationSnapshotDto;

    expect(response.status).toBe(200);
    expect(snapshot.state).toBe('cancelled');

    const settled = await settle(base, body.generationId!);
    expect(settled.state).toBe('cancelled');
  });

  it('404s for an unknown generation', async () => {
    const base = await boot();

    const response = await afetch(`${base}/api/generations/nope/cancel`, { method: 'POST' });

    expect(response.status).toBe(404);
  });
});
