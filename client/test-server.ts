import { vi } from 'vitest';

/**
 * A controllable stand-in for the server, used by the client state tests.
 *
 * The point is to make *timing* observable. Several of the properties this
 * phase is about — that the cold start overlaps, that an older response never
 * wins, that a slow request does not block a fast one — cannot be asserted
 * against a mock that resolves immediately: everything looks correct when
 * nothing can be out of order. Here each route is held open until the test
 * releases it, and the order of release is the test's to choose.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  /** Milliseconds since the server was installed, for overlap assertions. */
  startedAt: number;
}

interface Pending {
  url: string;
  method: string;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

export interface TestServer {
  /** Every request the client has made, in order. */
  readonly requests: RecordedRequest[];
  /** Requests currently awaiting a response. */
  readonly pending: readonly Pending[];
  /** Resolves the oldest pending request whose URL contains `match`. */
  respond: (match: string, body: unknown, status?: number) => void;
  /** Fails the oldest pending request whose URL contains `match`. */
  fail: (match: string, status: number, code: string, message?: string) => void;
  /** Resolves every pending request matching `match`. */
  respondAll: (match: string, body: unknown, status?: number) => void;
  /** Waits until a request whose URL contains `match` has been made. */
  waitFor: (match: string, count?: number) => Promise<void>;
  /** How many requests were made to URLs containing `match`. */
  countOf: (match: string) => number;
  restore: () => void;
}

export function installTestServer(): TestServer {
  const requests: RecordedRequest[] = [];
  const pending: Pending[] = [];
  const origin = performance.now();

  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        // `RequestInfo | URL` covers Request, whose default stringification is
        // useless; take its `url` explicitly.
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        requests.push({ url, method, startedAt: performance.now() - origin });

        const entry: Pending = { url, method, resolve, reject };
        pending.push(entry);

        // An aborted request rejects the way fetch does, so the layer under
        // test sees the same thing it would in a browser.
        init?.signal?.addEventListener('abort', () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })
  );

  const original = globalThis.fetch;
  globalThis.fetch = fetchMock;

  const take = (match: string): Pending | undefined => {
    const index = pending.findIndex((entry) => entry.url.includes(match));
    if (index < 0) return undefined;
    return pending.splice(index, 1)[0];
  };

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  return {
    requests,
    get pending() {
      return pending;
    },
    respond(match, body, status = 200) {
      const entry = take(match);
      if (entry === undefined) throw new Error(`no pending request matching "${match}"`);
      entry.resolve(json(body, status));
    },
    respondAll(match, body, status = 200) {
      for (let entry = take(match); entry !== undefined; entry = take(match)) {
        entry.resolve(json(body, status));
      }
    },
    fail(match, status, code, message = 'Failed.') {
      const entry = take(match);
      if (entry === undefined) throw new Error(`no pending request matching "${match}"`);
      entry.resolve(json({ error: { code, message } }, status));
    },
    async waitFor(match, count = 1) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (requests.filter((r) => r.url.includes(match)).length >= count) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(
        `no request matching "${match}" (saw: ${requests.map((r) => r.url).join(', ')})`
      );
    },
    countOf(match) {
      return requests.filter((r) => r.url.includes(match)).length;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** The session payload for a signed-in user. */
export function sessionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: {
      id: 'u-1',
      username: 'tester',
      role: 'user',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    csrfToken: 'csrf-token',
    registrationOpen: false,
    ...overrides,
  };
}

export function conversationsBody(
  conversations: { id: string; title: string }[]
): Record<string, unknown> {
  return {
    conversations: conversations.map(({ id, title }) => ({
      id,
      title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      malformed: false,
    })),
  };
}

/** The reader's own settings, as the shell asks for them on every mount. */
export function preferencesBody(
  defaultModel: { providerId: string; modelId: string } | null = null
): Record<string, unknown> {
  return { defaultModel };
}

export function modelsBody(
  models: { id: string }[] = [{ id: 'model-a' }],
  status: 'ready' | 'unavailable' = 'ready'
): Record<string, unknown> {
  return {
    providers: [
      {
        providerId: 'p1',
        providerName: 'Local',
        status,
        stale: false,
        models: models.map(({ id }) => ({ id, inputModalities: ['text'], loaded: true })),
      },
    ],
  };
}

export function conversationBody(
  id: string,
  messages: { type: 'user' | 'assistant'; id: string; body: string }[] = []
): Record<string, unknown> {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: messages.map((m) => (m.type === 'assistant' ? { ...m, status: 'complete' } : m)),
    activeGenerationId: null,
  };
}
