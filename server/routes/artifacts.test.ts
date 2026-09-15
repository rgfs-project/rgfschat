import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactSummary } from '@shared/artifact.ts';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { StoragePaths } from '../storage/paths.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';

/**
 * The artifact gallery over real HTTP.
 *
 * The interesting properties are not "does it return a list" but that it is a
 * projection: it must see what the Markdown says and nothing else, it must stay
 * inside the caller's own conversations (INV-15), and one broken file must not
 * take the whole gallery down with it.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let server: Server | undefined;
let base: string;
let store: ConversationStore;
let owner: TestClient;
let other: TestClient;
let ownerId: string;
let otherId: string;

const CODE = ['# Rate limiter', 'def allow(key):', '    return True'].join('\n');

async function conversationWith(userId: string, title: string, bodies: string[]): Promise<string> {
  const { id } = await store.create(userId, title);
  await store.appendMessages(
    userId,
    id,
    bodies.map((body) => ({
      type: 'assistant' as const,
      id: randomUUID(),
      status: 'complete' as const,
      body,
    }))
  );
  return id;
}

async function artifactsOf(client: TestClient): Promise<ArtifactSummary[]> {
  const response = await client.fetch('/api/artifacts');
  expect(response.status).toBe(200);
  return ((await response.json()) as { artifacts: ArtifactSummary[] }).artifacts;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'artifact-routes-'));
  const paths = new StoragePaths(dataDir);

  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });

  const app = createApp({
    logger,
    users,
    sessions,
    store,
    index,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const one = await users.create({ username: 'owner', password: 'a-good-password' });
  const two = await users.create({ username: 'other', password: 'another-password' });
  ownerId = one.id;
  otherId = two.id;
  owner = await signIn(base, sessions, one.id);
  other = await signIn(base, sessions, two.id);
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe('listing artifacts', () => {
  it('derives one from a fenced block, with a title from its leading comment', async () => {
    const id = await conversationWith(ownerId, 'Limits', [
      `Here:\n\n\`\`\`python\n${CODE}\n\`\`\``,
    ]);

    const [artifact, ...rest] = await artifactsOf(owner);
    expect(rest).toEqual([]);
    expect(artifact).toMatchObject({
      conversationId: id,
      conversationTitle: 'Limits',
      title: 'Rate limiter',
      language: 'python',
      lines: 3,
    });
  });

  it('addresses each block within its message, so two in one message are distinct', async () => {
    await conversationWith(ownerId, 'Two', [
      `\`\`\`sql\n-- First\nSELECT 1;\nSELECT 2;\n\`\`\`\n\n\`\`\`sql\n-- Second\nSELECT 3;\nSELECT 4;\n\`\`\``,
    ]);

    const artifacts = await artifactsOf(owner);
    expect(artifacts.map((a) => a.title)).toEqual(['First', 'Second']);

    const [first, second] = artifacts;
    expect(first?.messageId).toBe(second?.messageId);
    expect(first?.id).not.toBe(second?.id);
    expect(first?.id.endsWith('#0')).toBe(true);
    expect(second?.id.endsWith('#1')).toBe(true);
  });

  it('ignores a snippet too small to be worth opening', async () => {
    await conversationWith(ownerId, 'Small', ['Run `npm ci`:\n\n```sh\nnpm ci\n```']);
    expect(await artifactsOf(owner)).toEqual([]);
  });

  it('has nothing to list for a reader with no conversations', async () => {
    expect(await artifactsOf(owner)).toEqual([]);
  });
});

describe('it is a projection of the Markdown, not a second copy', () => {
  it('follows an edited message instead of going stale', async () => {
    const id = await conversationWith(ownerId, 'Edited', [`\`\`\`python\n${CODE}\n\`\`\``]);
    const before = await artifactsOf(owner);
    expect(before[0]?.title).toBe('Rate limiter');

    const conversation = await store.load(ownerId, id);
    const messageId = conversation.messages[0]?.id ?? '';
    await store.editMessageBody(
      ownerId,
      id,
      messageId,
      '```python\n# Token bucket\ndef allow(key):\n    return False\n```'
    );

    const after = await artifactsOf(owner);
    expect(after).toHaveLength(1);
    expect(after[0]?.title).toBe('Token bucket');
  });

  it('drops artifacts when their conversation is deleted', async () => {
    const id = await conversationWith(ownerId, 'Doomed', [`\`\`\`python\n${CODE}\n\`\`\``]);
    expect(await artifactsOf(owner)).toHaveLength(1);

    const response = await owner.fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(await artifactsOf(owner)).toEqual([]);
  });
});

describe('isolation and robustness', () => {
  it('INV-15: never lists another account’s artifacts', async () => {
    await conversationWith(ownerId, 'Mine', [`\`\`\`python\n${CODE}\n\`\`\``]);
    await conversationWith(otherId, 'Theirs', ['```sql\n-- Secret\nSELECT 1;\nSELECT 2;\n```']);

    expect((await artifactsOf(owner)).map((a) => a.title)).toEqual(['Rate limiter']);
    expect((await artifactsOf(other)).map((a) => a.title)).toEqual(['Secret']);
  });

  it('requires a session', async () => {
    const response = await fetch(`${base}/api/artifacts`);
    expect(response.status).toBe(401);
  });

  it('skips a malformed conversation rather than failing the whole gallery', async () => {
    await conversationWith(ownerId, 'Good', [`\`\`\`python\n${CODE}\n\`\`\``]);

    // Corrupt a real conversation, so the index genuinely lists it and the
    // gallery has to walk past it — rather than a stray file nothing knows of,
    // which would make this test pass without exercising anything.
    const doomed = await conversationWith(ownerId, 'Broken', [
      '```sql\n-- Unreachable\nSELECT 1;\nSELECT 2;\n```',
    ]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      new StoragePaths(dataDir).conversationFile(ownerId, doomed),
      'not a conversation at all\n',
      'utf8'
    );

    // The precondition: it is listed, and listed as malformed (§3.7).
    const listed = (await (await owner.fetch('/api/conversations')).json()) as {
      conversations: { id: string; malformed?: boolean }[];
    };
    expect(listed.conversations.find((c) => c.id === doomed)?.malformed).toBe(true);

    const artifacts = await artifactsOf(owner);
    expect(artifacts.map((a) => a.title)).toEqual(['Rate limiter']);
  });

  it('does not offer system prompts as artifacts', async () => {
    const { id } = await store.create(ownerId, 'System');
    await store.appendMessages(ownerId, id, [
      { type: 'system', id: randomUUID(), body: '```python\n# Hidden prompt\nx = 1\ny = 2\n```' },
    ]);

    expect(await artifactsOf(owner)).toEqual([]);
  });
});
