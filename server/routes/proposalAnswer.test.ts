import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { MemoryStore, MEMORIES_MAX_TOTAL_BYTES } from '../storage/memories.ts';
import { StoragePaths } from '../storage/paths.ts';
import { ProposalStore, type MemoryProposal } from '../storage/proposals.ts';

/**
 * Answering a memory proposal, over real HTTP.
 *
 * The three properties under test are the ones a reader notices when they are
 * missing, and all three were:
 *
 *  - a save that fails must leave the proposal where it was, or the model's
 *    suggestion is gone and there is nothing left to click;
 *  - accepting twice — two clicks, two tabs, a retried request — must apply
 *    the change once;
 *  - and an accepted proposal must never quietly land on a note it was not
 *    about: not one that already existed under that name, and not one the
 *    reader has edited since the model asked.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let server: Server | undefined;
let base: string;
let store: ConversationStore;
let memories: MemoryStore;
let proposals: ProposalStore;
let reader: TestClient;
let conversationId: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'proposal-answer-'));
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
  memories = new MemoryStore(paths, logger);
  proposals = new ProposalStore(paths, logger);

  const app = createApp({
    logger,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    store,
    index,
    memories,
    proposals,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const account = await users.create({ username: 'reader', password: 'a-good-password' });
  reader = await signIn(base, sessions, account.id);
  conversationId = (await store.create(account.id, 'Test')).id;
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dataDir, { recursive: true, force: true });
});

const MESSAGE = '33333333-3333-4333-8333-333333333333';

async function propose(
  entry: Partial<Omit<MemoryProposal, 'id' | 'createdAt'>> = {}
): Promise<MemoryProposal> {
  const base = {
    assistantMessageId: MESSAGE,
    operation: 'create' as const,
    name: 'coffee-order',
    content: 'Drinks flat whites.',
    ...entry,
  };
  // A deletion carries no content, here as everywhere else, so the key is
  // absent rather than undefined.
  const entries = Object.fromEntries(
    Object.entries(base).filter(([key]) => key !== 'content' || base.operation !== 'delete')
  ) as typeof base;
  const [created] = await proposals.add(reader.userId, conversationId, [entries]);
  return created as MemoryProposal;
}

function answer(proposalId: string, accept = true): Promise<Response> {
  return reader.fetch(`/api/conversations/${conversationId}/proposals/${proposalId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accept }),
  });
}

async function pending(): Promise<MemoryProposal[]> {
  return proposals.list(reader.userId, conversationId);
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return body.error;
}

/** Fills the store to just under its total cap, in notes that each fit. */
async function fillMemories(): Promise<void> {
  const each = 7 * 1024;
  for (let i = 0; i * each + each <= MEMORIES_MAX_TOTAL_BYTES - 1_024; i += 1) {
    await memories.write(reader.userId, `filler-${i}`, 'x'.repeat(each));
  }
}

describe('accepting a proposal', () => {
  it('writes the memory and disposes of the card', async () => {
    const proposal = await propose();

    const response = await answer(proposal.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applied: true,
      memory: { name: 'coffee-order', content: 'Drinks flat whites.' },
    });
    expect(await pending()).toEqual([]);
  });

  it('rejecting writes nothing and disposes of the card', async () => {
    const proposal = await propose();

    expect((await answer(proposal.id, false)).status).toBe(200);
    expect(await memories.list(reader.userId)).toEqual([]);
    expect(await pending()).toEqual([]);
  });
});

/*
 * Issue 1. `take` removed the proposal before `write` ran, so every refusal
 * below used to cost the reader the card as well as the note.
 */
describe('a save that fails', () => {
  it('keeps the proposal when the store refuses the content', async () => {
    // Whitespace-only reaches the store as empty. Filed straight into the
    // store, which is the only way to get past the tool-call validation — and
    // is exactly what a hand-edited proposals file can hold.
    const proposal = await propose({ content: '   \n  ' });

    const response = await answer(proposal.id);

    expect(response.status).toBe(400);
    expect(await pending()).toMatchObject([{ id: proposal.id }]);
  });

  it('keeps the proposal when the total quota is exceeded', async () => {
    await fillMemories();
    const proposal = await propose({ content: 'y'.repeat(5 * 1024) });

    const response = await answer(proposal.id);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('in total');
    expect(await pending()).toMatchObject([{ id: proposal.id }]);
    expect(await memories.read(reader.userId, 'coffee-order')).toBeNull();
  });

  it('keeps the proposal when the filesystem refuses the write', async () => {
    const proposal = await propose();
    // The memories directory replaced by a plain file: `ensureDir` fails, so
    // the write throws from below the validation layer, as a full or read-only
    // disk would. Everything else under the data directory — the proposals
    // file included — is left exactly as it was.
    const { writeFile } = await import('node:fs/promises');
    await rm(join(dataDir, reader.userId, 'memories'), { recursive: true, force: true });
    await writeFile(join(dataDir, reader.userId, 'memories'), 'not a directory');

    const response = await answer(proposal.id);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await pending()).toMatchObject([{ id: proposal.id }]);
  });

  it('can be accepted again once the cause is dealt with', async () => {
    await fillMemories();
    const proposal = await propose({ content: 'y'.repeat(5 * 1024) });

    expect((await answer(proposal.id)).status).toBe(400);
    for (const memory of await memories.list(reader.userId)) {
      await memories.remove(reader.userId, memory.name);
    }

    expect((await answer(proposal.id)).status).toBe(200);
    expect(await memories.read(reader.userId, 'coffee-order')).toMatchObject({
      content: 'y'.repeat(5 * 1024),
    });
  });
});

describe('answering the same proposal twice', () => {
  it('applies it once and calls the second a 404', async () => {
    const proposal = await propose();

    expect((await answer(proposal.id)).status).toBe(200);
    const second = await answer(proposal.id);

    expect(second.status).toBe(404);
    expect(await pending()).toEqual([]);
  });

  it('applies it once under two simultaneous accepts', async () => {
    const proposal = await propose();

    const responses = await Promise.all([answer(proposal.id), answer(proposal.id)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await memories.list(reader.userId)).toHaveLength(1);
  });

  /* An accept racing a reject must not leave a memory the reader refused. */
  it('does not apply an accept that lost to a reject', async () => {
    const proposal = await propose();

    const [accepted, rejected] = await Promise.all([
      answer(proposal.id),
      answer(proposal.id, false),
    ]);

    expect([accepted.status, rejected.status].sort()).toEqual([200, 404]);
    const applied = accepted.status === 200;
    expect(await memories.list(reader.userId)).toHaveLength(applied ? 1 : 0);
  });
});

/*
 * Issue 2. Both proposals used to be the same upsert, so a `remember` under a
 * name that already existed replaced the reader's note without a word.
 */
describe('a create proposal whose name is taken', () => {
  it('is refused as a conflict rather than overwriting', async () => {
    await memories.write(reader.userId, 'coffee-order', 'Drinks tea, actually.');
    const proposal = await propose();

    const response = await answer(proposal.id);

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('coffee-order');
    expect(await memories.read(reader.userId, 'coffee-order')).toMatchObject({
      content: 'Drinks tea, actually.',
    });
  });

  it('leaves the proposal there, so the reader can still decide', async () => {
    await memories.write(reader.userId, 'coffee-order', 'Drinks tea, actually.');
    const proposal = await propose();

    await answer(proposal.id);

    expect(await pending()).toMatchObject([{ id: proposal.id }]);
  });

  it('is refused when the collision is another proposal accepted first', async () => {
    const first = await propose();
    const second = await propose({ content: 'Drinks cortados.' });

    expect((await answer(first.id)).status).toBe(200);
    expect((await answer(second.id)).status).toBe(409);
    expect(await memories.read(reader.userId, 'coffee-order')).toMatchObject({
      content: 'Drinks flat whites.',
    });
  });
});

describe('an update proposal', () => {
  it('applies to the note it was made about', async () => {
    const written = await memories.write(reader.userId, 'employer', 'Works at Acme.');
    const proposal = await propose({
      operation: 'update',
      name: 'employer',
      content: 'Works at Globex.',
      baseUpdatedAt: written.updatedAt,
    });

    expect((await answer(proposal.id)).status).toBe(200);
    expect(await memories.read(reader.userId, 'employer')).toMatchObject({
      content: 'Works at Globex.',
    });
  });

  it('is a conflict when the note has changed since it was proposed', async () => {
    const written = await memories.write(reader.userId, 'employer', 'Works at Acme.');
    const proposal = await propose({
      operation: 'update',
      name: 'employer',
      content: 'Works at Globex.',
      baseUpdatedAt: written.updatedAt,
    });

    // The reader edits the note themselves, after the model asked.
    await memories.write(reader.userId, 'employer', 'Works at Initech.');

    const response = await answer(proposal.id);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toMatch(/changed since/i);
    expect(await memories.read(reader.userId, 'employer')).toMatchObject({
      content: 'Works at Initech.',
    });
    expect(await pending()).toMatchObject([{ id: proposal.id }]);
  });

  /* A proposal written before the baseline field existed still gets a check,
     against the moment the model asked. */
  it('is a conflict for a note edited after a baseline-less proposal was made', async () => {
    await memories.write(reader.userId, 'employer', 'Works at Acme.', {
      modifiedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const proposal = await propose({
      operation: 'update',
      name: 'employer',
      content: 'Works at Globex.',
    });

    expect((await answer(proposal.id)).status).toBe(409);
    expect(await memories.read(reader.userId, 'employer')).toMatchObject({
      content: 'Works at Acme.',
    });
  });

  it('is a conflict when the note is gone entirely', async () => {
    const proposal = await propose({
      operation: 'update',
      name: 'employer',
      content: 'Works at Globex.',
      baseUpdatedAt: new Date().toISOString(),
    });

    const response = await answer(proposal.id);

    expect(response.status).toBe(409);
    // Refused rather than quietly created: an update is not a create.
    expect(await memories.read(reader.userId, 'employer')).toBeNull();
  });
});

describe('a delete proposal', () => {
  it('removes the note it was made about', async () => {
    const written = await memories.write(reader.userId, 'employer', 'Works at Acme.');
    const proposal = await propose({
      operation: 'delete',
      name: 'employer',
      baseUpdatedAt: written.updatedAt,
    });

    expect((await answer(proposal.id)).status).toBe(200);
    expect(await memories.read(reader.userId, 'employer')).toBeNull();
  });

  it('refuses to delete a note edited since it was proposed', async () => {
    const written = await memories.write(reader.userId, 'employer', 'Works at Acme.');
    const proposal = await propose({
      operation: 'delete',
      name: 'employer',
      baseUpdatedAt: written.updatedAt,
    });

    await memories.write(reader.userId, 'employer', 'Works at Initech.');

    const response = await answer(proposal.id);

    expect(response.status).toBe(409);
    expect(await memories.read(reader.userId, 'employer')).toMatchObject({
      content: 'Works at Initech.',
    });
    expect(await pending()).toMatchObject([{ id: proposal.id }]);
  });

  /* Already gone is the outcome that was asked for; there is nothing to lose
     by agreeing, and a card that cannot be dismissed is its own bug. */
  it('accepts a deletion of a note that is already gone', async () => {
    const proposal = await propose({
      operation: 'delete',
      name: 'employer',
    });

    expect((await answer(proposal.id)).status).toBe(200);
    expect(await pending()).toEqual([]);
  });
});
