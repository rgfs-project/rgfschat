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
import { startMockProvider, type MockProvider } from '../provider/mockServer.ts';
import { ConversationStore } from './conversations.ts';
import { ChatIndex, type ChatIndexEntry } from './index.ts';
import { StoragePaths } from './paths.ts';

const logger = createLogger({ level: 'silent', write: () => {} });
const USER = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

let dataDir: string;
let paths: StoragePaths;
let store: ConversationStore;
let index: ChatIndex;
let service: GenerationService;
let manager: GenerationManager;
let mock: MockProvider | undefined;
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
  service = new GenerationService({
    store,
    index,
    manager,
    provider,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
  });

  const app = createApp({
    logger,
    provider,
    manager,
    store,
    index,
    service,
    userId: () => USER,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    const res = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title === undefined ? {} : { title }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  },
  async list() {
    const res = await fetch(`${base}/api/conversations`);
    return ((await res.json()) as { conversations: ChatIndexEntry[] }).conversations;
  },
  async get(id: string) {
    const res = await fetch(`${base}/api/conversations/${id}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  },
  async patch(id: string, body: unknown) {
    const res = await fetch(`${base}/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as never };
  },
  async remove(id: string) {
    const res = await fetch(`${base}/api/conversations/${id}`, { method: 'DELETE' });
    return res.status;
  },
  async editMessage(conversationId: string, messageId: string, body: string) {
    const res = await fetch(`${base}/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  },
  async deleteMessage(conversationId: string, messageId: string) {
    const res = await fetch(`${base}/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
    });
    // 204 when that emptied the conversation, which the server then deletes.
    const body = res.status === 204 ? null : ((await res.json()) as Record<string, unknown>);
    return { status: res.status, body };
  },
  async regenerate(conversationId: string, model = 'GPT') {
    const res = await fetch(`${base}/api/generations/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, model }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  },
  async send(conversationId: string, content: string, model = 'GPT') {
    const res = await fetch(`${base}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, model, content }),
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
    const res = await fetch(`${base}/api/conversations`, {
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
      provider: 'llamacpp',
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

    const extra = await fetch(`${base}/api/conversations/${id}/messages/${target.id}`, {
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
