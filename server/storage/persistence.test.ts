import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { EchoProvider } from '../provider/echoProvider.ts';
import { startMockProvider, type MockProvider } from '../provider/mockServer.ts';
import { ConversationStore } from './conversations.ts';
import { ChatIndex, type ChatIndexEntry } from './index.ts';
import { PreferencesStore } from './preferences.ts';
import { MemoryStore } from './memories.ts';
import { StoragePaths } from './paths.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { SessionManager } from '../auth/sessions.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';

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

let dataDir: string;
let paths: StoragePaths;
let store: ConversationStore;
let index: ChatIndex;
let preferences: PreferencesStore;
let memories: MemoryStore;
let service: GenerationService;
let manager: GenerationManager;
let mock: MockProvider | undefined;
let hub: ProviderHub;
let server: Server | undefined;
let base: string;

async function boot(options: Parameters<typeof startMockProvider>[0] = {}): Promise<void> {
  mock = await startMockProvider({ contentChunks: ['Hello', ' world'], ...options });
  const provider = new LlamaCppProvider(
    {
      baseUrl: mock.url,
      apiKey: undefined,
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

  preferences = new PreferencesStore(paths, logger);
  memories = new MemoryStore(paths, logger);

  const app = createApp({
    logger,
    hub,
    manager,
    store,
    index,
    preferences,
    memories,
    service,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = await signIn(base, sessions, USER);
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-persist-'));
  paths = new StoragePaths(dataDir);
  store = new ConversationStore({ paths, logger });
  index = new ChatIndex({ store, logger });
  await store.init(USER);
});

afterEach(async () => {
  manager?.shutdown();
  if (server !== undefined) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await mock?.close();
  mock = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const api = {
  async create(title?: string) {
    const res = await afetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  },
  async list() {
    const res = await afetch(`${base}/api/conversations`);
    return ((await res.json()) as { conversations: ChatIndexEntry[] }).conversations;
  },
  async get(id: string) {
    const res = await afetch(`${base}/api/conversations/${id}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  },
  async patch(id: string, body: unknown) {
    const res = await afetch(`${base}/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as never };
  },
  async remove(id: string) {
    const res = await afetch(`${base}/api/conversations/${id}`, { method: 'DELETE' });
    return res.status;
  },
  async editMessage(conversationId: string, messageId: string, body: string) {
    const res = await afetch(`${base}/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  },
  async deleteMessage(conversationId: string, messageId: string) {
    const res = await afetch(`${base}/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
    });
    // 204 when that emptied the conversation, which the server then deletes.
    const body = res.status === 204 ? null : ((await res.json()) as Record<string, unknown>);
    return { status: res.status, body };
  },
  async regenerate(conversationId: string, model = 'GPT') {
    const res = await afetch(`${base}/api/generations/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, providerId: 'local', model }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  },
  async search(query: string) {
    const res = await afetch(`${base}/api/conversations/search?q=${encodeURIComponent(query)}`);
    return {
      status: res.status,
      results: ((await res.json()) as { results?: unknown[] }).results ?? [],
    };
  },
  async pin(conversationId: string, pinned: boolean) {
    const res = await afetch(`${base}/api/conversations/${conversationId}/pin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as never };
  },
  async exportOne(conversationId: string) {
    const res = await afetch(`${base}/api/conversations/${conversationId}/export`);
    return {
      status: res.status,
      disposition: res.headers.get('content-disposition') ?? '',
      type: res.headers.get('content-type') ?? '',
      body: await res.text(),
    };
  },
  async send(conversationId: string, content: string, model = 'GPT', providerId = 'local') {
    const res = await afetch(`${base}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, providerId, model, content }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  },
};

describe('conversations API', () => {
  beforeEach(boot);

  it('creates, lists, reads, renames, and deletes', async () => {
    const created = await api.create('Trip planning');
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await api.list()).map((e) => e.id)).toEqual([id]);
    expect((await api.get(id)).body.title).toBe('Trip planning');

    const renamed = await api.patch(id, { title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect((await api.get(id)).body.title).toBe('Renamed');

    expect(await api.remove(id)).toBe(204);
    expect(await api.list()).toEqual([]);
    expect((await api.get(id)).status).toBe(404);
  });

  it('INV-02: rejects client-supplied timestamps and unknown fields', async () => {
    const res = await afetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', createdAt: '1999-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);

    const { body } = await api.create('ok');
    const id = body.id as string;
    expect(
      (await api.patch(id, { title: 'y', updatedAt: '1999-01-01T00:00:00.000Z' })).status
    ).toBe(400);
  });

  it('404s for a non-canonical id rather than leaking that it is malformed input', async () => {
    expect((await api.get('../../etc/passwd')).status).toBe(404);
    expect((await api.get('not-a-uuid')).status).toBe(404);
    expect(await api.remove(randomUUID())).toBe(404);
  });

  it('INV-10: a malformed conversation stays listed, refuses read and rename, allows delete', async () => {
    const { body } = await api.create('Healthy');
    const good = body.id as string;

    const bad = randomUUID();
    const corrupt = '---\nformatVersion: 9\n---\n';
    await writeFile(paths.conversationFile(USER, bad), corrupt);
    await index.rebuild(USER);

    const listed = await api.list();
    expect(listed.find((e) => e.id === bad)?.malformed).toBe(true);
    expect(listed.find((e) => e.id === good)?.malformed).toBe(false);

    expect((await api.get(bad)).status).toBe(422);
    expect((await api.get(bad)).body).toMatchObject({
      error: { code: 'CONVERSATION_MALFORMED' },
    });
    expect((await api.patch(bad, { title: 'nope' })).status).toBe(422);

    // Untouched by every refusal above.
    expect(await readFile(paths.conversationFile(USER, bad), 'utf8')).toBe(corrupt);

    // The healthy one still works, and the bad one can be removed.
    expect((await api.get(good)).status).toBe(200);
    expect(await api.remove(bad)).toBe(204);
  });
});

/**
 * Search is the only read that opens every conversation the caller owns, so
 * what it may return — and for whom — is worth stating in tests rather than
 * leaving to the shape of a loop.
 */
describe('conversation search', () => {
  beforeEach(boot);

  it('finds the message that matched, not just the conversation', async () => {
    const { body } = await api.create('Cooking');
    const id = body.id as string;
    await api.send(id, 'How long do I proof sourdough for?');
    await service.settled(USER, id);

    const { results } = await api.search('sourdough');
    expect(results).toHaveLength(1);

    const [result] = results as { id: string; hits: { messageId: string; snippet: string }[] }[];
    expect(result?.id).toBe(id);
    expect(result?.hits[0]?.snippet).toContain('sourdough');
    // The id is what lets the client scroll to the line rather than the top.
    expect(result?.hits[0]?.messageId).toBeTruthy();
  });

  it('matches a title even when no message contains the query', async () => {
    const { body } = await api.create('Sourdough');
    const id = body.id as string;
    await api.send(id, 'Something else entirely.');
    await service.settled(USER, id);

    const { results } = await api.search('sourdough');
    expect(results).toMatchObject([{ id, titleMatch: true, hits: [] }]);
  });

  it('is case-insensitive and returns nothing for a query that matches nothing', async () => {
    const { body } = await api.create('Cooking');
    const id = body.id as string;
    await api.send(id, 'Sourdough, mostly.');
    await service.settled(USER, id);

    expect((await api.search('SOURDOUGH')).results).toHaveLength(1);
    expect((await api.search('risotto')).results).toEqual([]);
  });

  it("reads only the caller's own conversations", async () => {
    const { body } = await api.create('Mine');
    const id = body.id as string;
    await api.send(id, 'A private note about sourdough.');
    await service.settled(USER, id);

    // A second user's conversation, written directly to their own directory.
    const other = '11111111-2222-4333-8444-555555555555';
    await store.init(other);
    const theirs = await store.create(other, 'Theirs');
    await store.appendMessages(other, theirs.id, [
      { type: 'user', id: randomUUID(), body: 'Their own sourdough note.' },
    ]);
    await index.rebuild(other);

    const { results } = await api.search('sourdough');
    expect(results).toHaveLength(1);
    expect((results as { id: string }[])[0]?.id).toBe(id);
  });

  it('survives an unreadable conversation instead of failing the whole search', async () => {
    const { body } = await api.create('Healthy');
    const id = body.id as string;
    await api.send(id, 'A note about sourdough.');
    await service.settled(USER, id);

    await writeFile(paths.conversationFile(USER, randomUUID()), '---\nformatVersion: 9\n---\n');
    await index.rebuild(USER);

    const { status, results } = await api.search('sourdough');
    expect(status).toBe(200);
    expect(results).toHaveLength(1);
  });

  it('answers an empty query with nothing rather than with everything', async () => {
    const { body } = await api.create('Cooking');
    await service.settled(USER, body.id as string);

    expect(await api.search('')).toMatchObject({ status: 200, results: [] });
    expect((await api.search('x'.repeat(201))).status).toBe(400);
  });
});

/**
 * Pinning is the reader's, not the conversation's.
 *
 * Which makes where it is stored the thing worth testing: the Markdown's front
 * matter is frozen at four keys, and the index is derived and rebuilt from the
 * files, so a pin kept in either would be either invalid or lost.
 */
describe('pinning', () => {
  beforeEach(boot);

  it('is reported in the list and survives an index rebuild', async () => {
    const { body } = await api.create('Kept');
    const id = body.id as string;

    expect((await api.list()).find((e) => e.id === id)).toMatchObject({ pinned: false });

    expect((await api.pin(id, true)).status).toBe(200);
    expect((await api.list()).find((e) => e.id === id)).toMatchObject({ pinned: true });

    // The index is derived: throwing it away must not throw the pin away.
    await index.rebuild(USER);
    expect((await api.list()).find((e) => e.id === id)).toMatchObject({ pinned: true });

    // And the conversation file itself is untouched by any of it.
    const raw = await readFile(paths.conversationFile(USER, id), 'utf8');
    expect(raw).not.toContain('pinned');

    expect((await api.pin(id, false)).status).toBe(200);
    expect((await api.list()).find((e) => e.id === id)).toMatchObject({ pinned: false });
  });

  it('refuses to pin a conversation that does not exist', async () => {
    expect((await api.pin(randomUUID(), true)).status).toBe(404);
    expect((await api.pin('not-a-uuid', true)).status).toBe(404);
  });

  it('is dropped when the conversation is deleted', async () => {
    const { body } = await api.create('Doomed');
    const id = body.id as string;
    await api.pin(id, true);

    expect(await api.remove(id)).toBe(204);
    expect(await preferences.pinned(USER)).not.toContain(id);
  });

  it("is one reader's alone", async () => {
    const { body } = await api.create('Mine');
    const id = body.id as string;
    await api.pin(id, true);

    const other = '11111111-2222-4333-8444-555555555555';
    expect(await preferences.pinned(other)).toEqual(new Set());
  });

  it('ignores a preferences file that cannot be read', async () => {
    const { body } = await api.create('Kept');
    const id = body.id as string;
    await api.pin(id, true);

    await writeFile(paths.preferencesFile(USER), '{ not json');

    // Degraded, not broken: the list still answers, without the pin.
    expect((await api.list()).find((e) => e.id === id)).toMatchObject({ pinned: false });
  });
});

describe('export', () => {
  beforeEach(boot);

  it('serves the stored file byte for byte, named after the conversation', async () => {
    const { body } = await api.create('Trip planning');
    const id = body.id as string;
    await api.send(id, 'hello there');
    await service.settled(USER, id);

    const exported = await api.exportOne(id);
    expect(exported.status).toBe(200);
    expect(exported.type).toContain('text/markdown');
    expect(exported.disposition).toContain('filename="Trip planning.md"');
    expect(exported.body).toBe(await readFile(paths.conversationFile(USER, id), 'utf8'));
  });

  it('keeps a hostile title out of the header', async () => {
    const { body } = await api.create('a"b; drop=1');
    const id = body.id as string;

    const exported = await api.exportOne(id);
    expect(exported.status).toBe(200);
    // No quote and no semicolon survive into the quoted filename, so neither
    // can end the header field early; the percent-encoded copy keeps the real
    // title for clients that read it.
    expect(exported.disposition).toContain('filename="a_b_ drop_1.md"');
    expect(exported.disposition).not.toContain('drop=1.md"');
    expect(exported.disposition).toContain("filename*=UTF-8''");
  });

  it("404s for a conversation that is not the caller's", async () => {
    expect((await api.exportOne(randomUUID())).status).toBe(404);
  });
});

/**
 * What a reader can change about their own account.
 *
 * The scoping is the property worth testing: these routes take no user to act
 * on, so the only account they can reach is the caller's.
 */
describe("a reader's own settings", () => {
  beforeEach(boot);

  const me = (path: string, init: RequestInit = {}) =>
    afetch(`${base}/api/me${path}`, {
      ...init,
      ...(init.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
    });

  it('remembers a default model and gives it back', async () => {
    expect(await (await me('/preferences')).json()).toEqual({ defaultModel: null });

    const set = await me('/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel: { providerId: 'local', modelId: 'GPT' } }),
    });
    expect(set.status).toBe(200);

    expect(await (await me('/preferences')).json()).toEqual({
      defaultModel: { providerId: 'local', modelId: 'GPT' },
    });

    // Clearing returns the reader to the instance default.
    await me('/preferences', { method: 'PATCH', body: JSON.stringify({ defaultModel: null }) });
    expect(await (await me('/preferences')).json()).toEqual({ defaultModel: null });
  });

  it('keeps a default model and a pin in the same file without losing either', async () => {
    const { body } = await api.create('Kept');
    const id = body.id as string;

    await api.pin(id, true);
    await me('/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel: { providerId: 'local', modelId: 'GPT' } }),
    });

    expect(await preferences.pinned(USER)).toContain(id);
    expect((await preferences.read(USER)).defaultModel).toEqual({
      providerId: 'local',
      modelId: 'GPT',
    });
  });

  it("clears only the caller's own conversations", async () => {
    const mine = await api.create('Mine');
    await service.settled(USER, mine.body.id as string);

    const other = '11111111-2222-4333-8444-555555555555';
    await store.init(other);
    const theirs = await store.create(other, 'Theirs');
    await index.rebuild(other);

    const res = await me('/history/clear', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);

    expect(await api.list()).toEqual([]);
    // The other account still has its conversation, file and all.
    expect(await store.exists(other, theirs.id)).toBe(true);
  });

  it('refuses to clear without an explicit confirmation', async () => {
    await api.create('Kept');
    const res = await me('/history/clear', { method: 'POST', body: JSON.stringify({}) });

    expect(res.status).toBe(400);
    expect(await api.list()).toHaveLength(1);
  });

  it('stores a memory as a file and reads it back', async () => {
    const written = await me('/memories', {
      method: 'PUT',
      body: JSON.stringify({ name: 'how-i-write', content: 'Short sentences.' }),
    });
    expect(written.status).toBe(200);

    const { memories: list } = (await (await me('/memories')).json()) as {
      memories: { name: string; content: string }[];
    };
    expect(list).toMatchObject([{ name: 'how-i-write', content: 'Short sentences.' }]);

    // On disk, as Markdown, under the name it was given.
    expect(await readFile(paths.memoryFile(USER, 'how-i-write'), 'utf8')).toBe('Short sentences.');

    expect((await me('/memories/how-i-write', { method: 'DELETE' })).status).toBe(204);
    expect(await memories.list(USER)).toEqual([]);
  });

  it('refuses a name that would leave the memories directory', async () => {
    for (const name of ['../escape', 'Has Spaces', 'UPPER', '']) {
      const res = await me('/memories', {
        method: 'PUT',
        body: JSON.stringify({ name, content: 'x' }),
      });
      expect(res.status, name).toBe(400);
    }
    expect(await memories.list(USER)).toEqual([]);
  });

  /**
   * INV-14: identity comes from the session, never from the request.
   *
   * Written after a sabotage survived the rest of this block: proving that no
   * route *offers* a way to name another account is not the same as proving
   * one cannot be smuggled in. This sends the parameter anyway.
   */
  it('ignores a user named in the request', async () => {
    const other = '11111111-2222-4333-8444-555555555555';
    await store.init(other);
    const theirs = await store.create(other, 'Theirs');
    await index.rebuild(other);

    await api.create('Mine');

    const cleared = await afetch(`${base}/api/me/history/clear?userId=${other}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(cleared.status).toBe(200);

    // The caller's own went; the account they tried to name is untouched.
    expect(await api.list()).toEqual([]);
    expect(await store.exists(other, theirs.id)).toBe(true);

    await afetch(`${base}/api/me/memories?userId=${other}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'smuggled', content: 'x' }),
    });
    expect(await memories.list(other)).toEqual([]);
    expect((await memories.list(USER)).map((m) => m.name)).toEqual(['smuggled']);
  });

  it("is one reader's memory alone", async () => {
    await me('/memories', {
      method: 'PUT',
      body: JSON.stringify({ name: 'mine', content: 'Only mine.' }),
    });

    const other = '11111111-2222-4333-8444-555555555555';
    expect(await memories.list(other)).toEqual([]);
  });
});

describe('INV-11: the index is derived', () => {
  beforeEach(boot);

  it('rebuilds after the index file is deleted', async () => {
    const { body } = await api.create('Kept');
    const id = body.id as string;

    await index.destroy(USER);

    const listed = await api.list();
    expect(listed.map((e) => e.id)).toEqual([id]);
    expect(listed[0]?.title).toBe('Kept');
  });

  it('rebuilds when the index is unparseable', async () => {
    await api.create('Kept');
    await writeFile(paths.chatsIndexFile(USER), 'not json at all');

    expect(await api.list()).toHaveLength(1);
  });

  it('rebuilds when the index was left dirty by a crash', async () => {
    const { body } = await api.create('Kept');
    const raw = JSON.parse(await readFile(paths.chatsIndexFile(USER), 'utf8')) as {
      dirty: boolean;
      entries: unknown[];
    };
    // Simulate dying mid-update: marked dirty, and stale content.
    await writeFile(
      paths.chatsIndexFile(USER),
      JSON.stringify({ ...raw, dirty: true, entries: [] })
    );

    const listed = await api.list();
    expect(listed.map((e) => e.id)).toEqual([body.id]);
  });

  it('reflects a hand-edit to Markdown after a rebuild', async () => {
    const { body } = await api.create('Before');
    const id = body.id as string;
    const file = paths.conversationFile(USER, id);

    const raw = await readFile(file, 'utf8');
    await writeFile(file, raw.replace('"Before"', '"Edited by hand"'));

    // The cached index still shows the old title...
    expect((await api.list())[0]?.title).toBe('Before');
    // ...and the canonical file is authoritative on read and after a rebuild.
    expect((await api.get(id)).body.title).toBe('Edited by hand');
    await index.rebuild(USER);
    expect((await api.list())[0]?.title).toBe('Edited by hand');
  });
});

describe('generation persistence', () => {
  it('INV-08: the user message is durable before 202 is returned', async () => {
    await boot({ chunkDelayMs: 40 });
    const { body } = await api.create();
    const id = body.id as string;

    const sent = await api.send(id, 'hello there');
    expect(sent.status).toBe(202);
    expect(sent.body.userMessageId).toBeTruthy();

    // Read the file directly — not via any cache — immediately after 202.
    const raw = await readFile(paths.conversationFile(USER, id), 'utf8');
    expect(raw).toContain('hello there');
    expect(raw).toContain(sent.body.userMessageId);

    await service.settled(USER, id);
  });

  it('INV-07: the assistant message is written exactly once, with status and model', async () => {
    await boot({ reasoningChunks: ['thinking'], contentChunks: ['Hi', ' there'] });
    const { body } = await api.create();
    const id = body.id as string;

    await api.send(id, 'hello');
    await service.settled(USER, id);

    const conversation = await store.load(USER, id);
    const assistants = conversation.messages.filter((m) => m.type === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      status: 'complete',
      provider: 'local',
      model: 'GPT',
      reasoning: 'thinking',
      body: 'Hi there',
    });

    const raw = await readFile(paths.conversationFile(USER, id), 'utf8');
    expect(raw.match(/cc:assistant/g)).toHaveLength(1);
    expect(raw.match(/cc:reasoning/g)).toHaveLength(1);
  });

  it('maps the completed generation state to the "complete" markdown status', async () => {
    await boot();
    const { body } = await api.create();
    const id = body.id as string;

    await api.send(id, 'hello');
    await service.settled(USER, id);

    // The enums differ by design: generation says "completed", markdown "complete".
    const raw = await readFile(paths.conversationFile(USER, id), 'utf8');
    expect(raw).toContain('status=complete ');
    expect(raw).not.toContain('status=completed');
  });

  it('INV-13: a second send while one is in flight is rejected and persists nothing', async () => {
    await boot({ chunkDelayMs: 60 });
    const { body } = await api.create();
    const id = body.id as string;

    await api.send(id, 'first');
    const second = await api.send(id, 'second');

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: { code: 'GENERATION_IN_PROGRESS' } });

    await service.settled(USER, id);
    const raw = await readFile(paths.conversationFile(USER, id), 'utf8');
    expect(raw).toContain('first');
    expect(raw).not.toContain('second');
  });

  it('auto-titles from the first user message once a reply completes', async () => {
    await boot();
    const { body } = await api.create();
    const id = body.id as string;
    expect(body.title).toBe('New conversation');

    await api.send(id, 'What is the capital of France?');
    await service.settled(USER, id);

    expect((await store.load(USER, id)).title).toBe('What is the capital of France?');
  });

  it('does not auto-title a conversation that was renamed', async () => {
    await boot();
    const { body } = await api.create('My own title');
    const id = body.id as string;

    await api.send(id, 'something entirely different');
    await service.settled(USER, id);

    expect((await store.load(USER, id)).title).toBe('My own title');
  });

  it('titles from the first user message even when an earlier generation failed', async () => {
    // A failed run leaves the title at its default, so the next completed run
    // must still title from the question that opened the conversation
    // (contracts §3.3), not from the message that happened to succeed.
    await boot({ failWith: { status: 500, message: 'boom' } });
    const { body } = await api.create();
    const id = body.id as string;

    await api.send(id, 'the original question');
    await service.settled(USER, id);
    expect((await store.load(USER, id)).title).toBe('New conversation');

    // Swap in a provider that succeeds, keeping the same storage.
    await mock?.close();
    mock = await startMockProvider({ contentChunks: ['ok'] });
    const provider = new LlamaCppProvider(
      {
        baseUrl: mock.url,
        apiKey: undefined,
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
    service = new GenerationService({
      store,
      index,
      manager,
      hub,
      logger,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
    });

    await service.start(USER, id, 'local', 'GPT', 'a later question');
    await service.settled(USER, id);

    expect((await store.load(USER, id)).title).toBe('the original question');
  });

  it('deletes the Markdown before the index entry', async () => {
    await boot();
    const { body } = await api.create('To be deleted');
    const id = body.id as string;

    const order: string[] = [];
    const realDelete = store.delete.bind(store);
    const realRemove = index.remove.bind(index);
    store.delete = async (u, c) => {
      order.push('markdown');
      return realDelete(u, c);
    };
    index.remove = async (u, c) => {
      order.push('index');
      return realRemove(u, c);
    };

    await api.remove(id);

    // Markdown first: an orphaned index entry is recoverable by a rebuild,
    // a dangling entry pointing at a live file is not.
    expect(order).toEqual(['markdown', 'index']);
    store.delete = realDelete;
    index.remove = realRemove;
  });

  it('discards output for a conversation deleted mid-generation', async () => {
    await boot({ chunkDelayMs: 40 });
    const { body } = await api.create();
    const id = body.id as string;

    await api.send(id, 'hello');
    expect(await api.remove(id)).toBe(204);

    await service.settled(USER, id);

    // Not resurrected.
    expect(await store.exists(USER, id)).toBe(false);
    expect(await api.list()).toEqual([]);
  });

  it('survives a restart with the same DATA_DIR', async () => {
    await boot();
    const { body } = await api.create('Persistent');
    const id = body.id as string;
    await api.send(id, 'remember me');
    await service.settled(USER, id);

    // Tear the process-equivalent down and build a fresh stack on the same dir.
    manager.shutdown();
    const fresh = new ConversationStore({ paths: new StoragePaths(dataDir), logger });
    const freshIndex = new ChatIndex({ store: fresh, logger });
    await fresh.init(USER);

    const loaded = await fresh.load(USER, id);
    // Created with an explicit title, so auto-titling stayed disabled.
    expect(loaded.title).toBe('Persistent');
    expect(loaded.messages.filter((m) => m.type === 'user')[0]?.body).toBe('remember me');
    expect(loaded.messages.filter((m) => m.type === 'assistant')).toHaveLength(1);
    expect((await freshIndex.list(USER)).map((e) => e.id)).toEqual([id]);
  });
});

describe('message editing, deletion, and regeneration', () => {
  /** Builds a conversation with two complete turns. */
  async function twoTurns(): Promise<{ id: string; messages: { id: string; type: string }[] }> {
    const { body } = await api.create('Fixed title');
    const id = body.id as string;
    await api.send(id, 'first question');
    await service.settled(USER, id);
    await api.send(id, 'second question');
    await service.settled(USER, id);

    const loaded = await store.load(USER, id);
    return { id, messages: loaded.messages.map((m) => ({ id: m.id, type: m.type })) };
  }

  it('edits a message body and leaves everything else untouched', async () => {
    await boot();
    const { id, messages } = await twoTurns();
    const target = messages[0] as { id: string };

    const before = await store.load(USER, id);
    const res = await api.editMessage(id, target.id, 'an edited question');

    expect(res.status).toBe(200);
    const after = await store.load(USER, id);
    expect(after.messages[0]?.body).toBe('an edited question');
    expect(after.messages).toHaveLength(before.messages.length);
    // Ids, types, and recorded assistant metadata are records of what happened.
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages.map((m) => m.type)).toEqual(before.messages.map((m) => m.type));
    expect(after.createdAt).toBe(before.createdAt);
  });

  it('rejects an edit that would empty a message, and unknown fields', async () => {
    await boot();
    const { id, messages } = await twoTurns();
    const target = messages[0] as { id: string };

    expect((await api.editMessage(id, target.id, '')).status).toBe(400);

    const extra = await afetch(`${base}/api/conversations/${id}/messages/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x', type: 'system' }),
    });
    expect(extra.status).toBe(400);
  });

  it('404s editing a message that does not exist', async () => {
    await boot();
    const { id } = await twoTurns();

    expect((await api.editMessage(id, randomUUID(), 'nope')).status).toBe(404);
  });

  it('deleting a user message takes its reply with it and keeps later turns', async () => {
    await boot();
    const { body } = await api.create('Three turns');
    const id = body.id as string;
    for (const question of ['first', 'second', 'third']) {
      await api.send(id, question);
      await service.settled(USER, id);
    }
    const before = await store.load(USER, id);
    expect(before.messages).toHaveLength(6);

    // Delete the *middle* user message: it and its answer go, the rest stay.
    const target = before.messages[2] as { id: string };
    const res = await api.deleteMessage(id, target.id);

    expect(res.status).toBe(200);
    const after = await store.load(USER, id);
    expect(after.messages).toHaveLength(4);
    expect(after.messages.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(after.messages.map((m) => m.body)).toEqual([
      'first',
      before.messages[1]?.body,
      'third',
      before.messages[5]?.body,
    ]);
  });

  it('deleting an assistant message leaves the question in place', async () => {
    await boot();
    const { id, messages } = await twoTurns();

    const assistant = messages[1] as { id: string };
    await api.deleteMessage(id, assistant.id);

    const after = await store.load(USER, id);
    expect(after.messages).toHaveLength(3);
    expect(after.messages.map((m) => m.type)).toEqual(['user', 'user', 'assistant']);
  });

  it('deleting the last remaining exchange removes the conversation itself', async () => {
    await boot();
    const { body } = await api.create();
    const id = body.id as string;
    await api.send(id, 'only question');
    await service.settled(USER, id);

    const loaded = await store.load(USER, id);
    const firstMessage = loaded.messages[0] as { id: string };

    const res = await api.deleteMessage(id, firstMessage.id);

    expect(res.status).toBe(204);
    expect(await store.exists(USER, id)).toBe(false);
    expect(await api.list()).toEqual([]);
    expect((await api.get(id)).status).toBe(404);
  });

  it('does not remove a conversation that is empty because it was just created', async () => {
    await boot();
    const { body } = await api.create();
    const id = body.id as string;

    // Only a delete may remove a conversation; creation must not self-destruct.
    expect(await store.exists(USER, id)).toBe(true);
    expect((await api.get(id)).status).toBe(200);
    expect((await api.list()).map((e) => e.id)).toEqual([id]);
  });

  it('regenerate replaces the last assistant turn rather than appending one', async () => {
    await boot();
    const { id, messages } = await twoTurns();
    const originalAssistantId = messages[3]?.id;

    const res = await api.regenerate(id);
    expect(res.status).toBe(202);
    await service.settled(USER, id);

    const after = await store.load(USER, id);
    expect(after.messages).toHaveLength(4);
    expect(after.messages.at(-1)?.type).toBe('assistant');
    // A new assistant message, not the old one kept alongside a new one.
    expect(after.messages.at(-1)?.id).not.toBe(originalAssistantId);
    expect(after.messages.filter((m) => m.type === 'assistant')).toHaveLength(2);
  });

  it('regenerate does not re-title a conversation', async () => {
    await boot();
    const { id } = await twoTurns();

    await api.regenerate(id);
    await service.settled(USER, id);

    expect((await store.load(USER, id)).title).toBe('Fixed title');
  });

  it('refuses to regenerate when there is no user message to answer', async () => {
    await boot();
    const { body } = await api.create();
    const id = body.id as string;

    expect((await api.regenerate(id)).status).toBe(400);
  });

  it('INV-13: refuses to regenerate while a generation is in flight', async () => {
    await boot({ chunkDelayMs: 60 });
    const { body } = await api.create();
    const id = body.id as string;
    await api.send(id, 'first');

    expect((await api.regenerate(id)).status).toBe(409);
    await service.settled(USER, id);
  });

  it('INV-10: refuses to edit or delete a message in a malformed conversation', async () => {
    await boot();
    const bad = randomUUID();
    const corrupt = '---\nformatVersion: 9\n---\n';
    await writeFile(paths.conversationFile(USER, bad), corrupt);

    expect((await api.editMessage(bad, randomUUID(), 'x')).status).toBe(422);
    expect((await api.deleteMessage(bad, randomUUID())).status).toBe(422);
    expect(await readFile(paths.conversationFile(USER, bad), 'utf8')).toBe(corrupt);
  });

  it('INV-12: rejects a non-canonical message id without touching the filesystem', async () => {
    await boot();
    const { id } = await twoTurns();

    expect((await api.editMessage(id, '../../etc/passwd', 'x')).status).toBe(404);
    expect((await api.deleteMessage(id, 'not-a-uuid')).status).toBe(404);
  });
});

describe('conversations stay provider independent (contracts §4)', () => {
  /** Two providers with distinct models, both reachable from one conversation. */
  async function bootTwoProviders(): Promise<void> {
    const alpha = new EchoProvider({
      models: [{ id: 'alpha-1', inputModalities: ['text'], loaded: true }],
      reply: () => ({ content: 'from alpha' }),
    });
    const beta = new EchoProvider({
      models: [{ id: 'beta-1', inputModalities: ['text'], loaded: true }],
      reply: () => ({ content: 'from beta' }),
    });

    manager = new GenerationManager({ logger, maxOutputTokens: 128 });
    hub = new ProviderHub({
      logger,
      policy: DEFAULT_HOST_POLICY,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
      factory: (config) => (config.id === 'alpha' ? alpha : beta),
    });
    hub.setProviders([
      {
        id: 'alpha',
        name: 'Alpha',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1',
        timeoutMs: 5_000,
        capabilities: {},
      },
      {
        id: 'beta',
        name: 'Beta',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:2',
        timeoutMs: 5_000,
        capabilities: {},
      },
    ]);

    service = new GenerationService({
      store,
      index,
      manager,
      hub,
      logger,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
    });

    const users = new UserStore({ paths: store.paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
    const sessions = new SessionManager({
      paths: store.paths,
      logger,
      absoluteTtlMs: 3_600_000,
      idleTtlMs: 3_600_000,
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
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = await signIn(base, sessions, USER);
  }

  it('records the provider and model that actually produced each turn', async () => {
    await bootTwoProviders();
    const { body } = await api.create('Mixed providers');
    const id = body.id as string;

    const first = await api.send(id, 'first question', 'alpha-1', 'alpha');
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    await service.settled(USER, id);
    const second = await api.send(id, 'second question', 'beta-1', 'beta');
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    await service.settled(USER, id);

    const conversation = await store.load(USER, id);
    const assistants = conversation.messages.filter((m) => m.type === 'assistant');

    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({
      provider: 'alpha',
      model: 'alpha-1',
      body: 'from alpha',
    });
    expect(assistants[1]).toMatchObject({ provider: 'beta', model: 'beta-1', body: 'from beta' });
  });

  it('INV-18: refuses a model that belongs to the other provider', async () => {
    await bootTwoProviders();
    const { body } = await api.create();
    const id = body.id as string;

    // alpha-1 is real, but not on beta. The browser saying so is not enough.
    const wrong = await api.send(id, 'hello', 'alpha-1', 'beta');
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: { code: 'MODEL_NOT_FOUND' } });

    const unknownProvider = await api.send(id, 'hello', 'alpha-1', 'ghost');
    expect(unknownProvider.status).toBe(400);
    expect(unknownProvider.body).toMatchObject({ error: { code: 'PROVIDER_NOT_FOUND' } });
  });

  it('removing a provider leaves existing conversations readable and intact', async () => {
    await bootTwoProviders();
    const { body } = await api.create('Survives removal');
    const id = body.id as string;

    const sent = await api.send(id, 'answered by beta', 'beta-1', 'beta');
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await service.settled(USER, id);

    const before = await readFile(paths.conversationFile(USER, id), 'utf8');

    // Beta disappears from configuration entirely.
    hub.setProviders([
      {
        id: 'alpha',
        name: 'Alpha',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1',
        timeoutMs: 5_000,
        capabilities: {},
      },
    ]);

    // The file is untouched, still names beta, and still loads.
    expect(await readFile(paths.conversationFile(USER, id), 'utf8')).toBe(before);
    const loaded = await store.load(USER, id);
    expect(loaded.messages.filter((m) => m.type === 'assistant')[0]).toMatchObject({
      provider: 'beta',
    });
    expect((await api.get(id)).status).toBe(200);

    // It just cannot be selected for a new generation any more.
    const attempt = await api.send(id, 'again', 'beta-1', 'beta');
    expect(attempt.status).toBe(400);
  });
});
