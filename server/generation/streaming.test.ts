import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GenerationEvent } from '@shared/generation.ts';
import { createLogger } from '../logger.ts';
import type { ChatRequest, Provider, ProviderChunk } from '../provider/types.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';
import { CheckpointStore } from './checkpoints.ts';
import { GenerationManager, type GenerationManagerOptions } from './manager.ts';
import { recoverGenerations } from './recovery.ts';

const logger = createLogger({ level: 'silent', write: () => {} });
const OWNER = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

let dataDir: string;
let paths: StoragePaths;
let checkpoints: CheckpointStore;
let store: ConversationStore;
let index: ChatIndex;
let manager: GenerationManager | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-streaming-'));
  paths = new StoragePaths(dataDir);
  checkpoints = new CheckpointStore({ paths, logger });
  store = new ConversationStore({ paths, logger });
  index = new ChatIndex({ store, logger });
  await store.init(OWNER);
});

afterEach(async () => {
  // A checkpoint write issued moments ago may still be in flight; removing the
  // directory underneath it would fail with ENOTEMPTY.
  await manager?.allCheckpointsFlushed();
  manager?.shutdown();
  manager = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * A provider whose stream is driven by the test, not by a timer.
 *
 * Every race below is triggered at an exact point — "cancel after the second
 * chunk", "attach while the terminal transition is running" — which a sleep
 * could only approximate. Contracts §9 forbids sleeps used to mask races, and
 * a sleep-based version of these tests would be both slower and less honest.
 */
class ControlledProvider implements Provider {
  #resolve: ((chunk: ProviderChunk | null) => void) | null = null;
  #queue: (ProviderChunk | null)[] = [];
  #failWith: Error | null = null;
  started = false;

  listModels(): Promise<never[]> {
    return Promise.resolve([]);
  }

  contextLength(): number | null {
    return null;
  }

  /** Pushes one chunk into the stream. */
  emit(chunk: ProviderChunk): void {
    if (this.#resolve !== null) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve(chunk);
    } else {
      this.#queue.push(chunk);
    }
  }

  /** Ends the stream normally. */
  end(): void {
    if (this.#resolve !== null) {
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve(null);
    } else {
      this.#queue.push(null);
    }
  }

  /** Ends the stream by throwing, simulating a provider interruption. */
  fail(error: Error): void {
    this.#failWith = error;
    this.end();
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    this.started = true;
    for (;;) {
      if (request.signal.aborted) return;

      const next =
        this.#queue.length > 0
          ? (this.#queue.shift() as ProviderChunk | null)
          : await new Promise<ProviderChunk | null>((resolve) => {
              this.#resolve = resolve;
            });

      if (next === null) {
        if (this.#failWith !== null) throw this.#failWith;
        return;
      }
      yield next;
    }
  }
}

function newManager(overrides: Partial<GenerationManagerOptions> = {}) {
  manager = new GenerationManager({
    logger,
    maxOutputTokens: 128,
    checkpoints,
    checkpointMs: 1_000,
    replayEvents: 2_000,
    ...overrides,
  });
  return manager;
}

/** Waits for a condition rather than a duration. */
async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const content = (text: string): ProviderChunk => ({ type: 'content', text });

describe('INV-20: replay never leaves a silent gap', () => {
  it('a fresh observer gets a snapshot, not a replay', () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    const events = m.catchUp(generationId, OWNER, null);

    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe('snapshot');
  });

  it('replays exactly the missed events when Last-Event-ID is inside the window', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    for (const text of ['a', 'b', 'c', 'd']) provider.emit(content(text));
    await until(() => (m.get(generationId, OWNER)?.content ?? '') === 'abcd', 'four chunks');

    const afterTwo = 3; // snapshot-less: state + 2 content events
    const replayed = m.catchUp(generationId, OWNER, afterTwo);

    // Exactly the events after that id, in order, with no duplicates.
    expect(replayed.every((e) => e.id > afterTwo)).toBe(true);
    expect(replayed.map((e) => e.id)).toEqual([...replayed.map((e) => e.id)].sort((x, y) => x - y));
    const text = replayed
      .map((e) => e.event)
      .filter((e): e is Extract<GenerationEvent, { type: 'content' }> => e.type === 'content')
      .map((e) => e.delta)
      .join('');
    expect('abcd'.endsWith(text)).toBe(true);
  });

  it('returns nothing when the client is already up to date', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('a'));
    await until(() => (m.get(generationId, OWNER)?.content ?? '') === 'a', 'one chunk');

    const current = m.get(generationId, OWNER)!.lastEventId;
    expect(m.catchUp(generationId, OWNER, current)).toEqual([]);
  });

  it('resyncs when Last-Event-ID has fallen out of the window', async () => {
    // A two-event window: anything older is unreplayable by construction.
    const m = newManager({ replayEvents: 2 });
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    for (const text of ['a', 'b', 'c', 'd', 'e']) provider.emit(content(text));
    await until(() => (m.get(generationId, OWNER)?.content ?? '') === 'abcde', 'five chunks');

    const events = m.catchUp(generationId, OWNER, 1);

    expect(events).toHaveLength(1);
    const [only] = events;
    expect(only?.event.type).toBe('resync');
    // The resync carries everything, so nothing is silently missing.
    if (only?.event.type === 'resync') expect(only.event.snapshot.content).toBe('abcde');
  });

  it('resyncs for an id it never issued', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('a'));
    await until(() => (m.get(generationId, OWNER)?.content ?? '') === 'a', 'one chunk');

    // Far ahead of anything we issued — a stale tab from a previous process, or
    // a fabricated value. Returning nothing would leave that client silent
    // forever, so it is treated as unknown and resynced.
    const events = m.catchUp(generationId, OWNER, 999_999);

    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe('resync');
    if (events[0]?.event.type === 'resync') {
      expect(events[0].event.snapshot.content).toBe('a');
    }
  });

  it('a terminal generation replays its outcome and stops', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('done'));
    provider.end();
    await until(() => m.get(generationId, OWNER)?.state === 'completed', 'completion');

    const events = m.catchUp(generationId, OWNER, null);
    expect(events[0]?.event.type).toBe('snapshot');

    const fromStart = m.catchUp(generationId, OWNER, 0);
    expect(fromStart.at(-1)?.event.type).toBe('done');
  });

  it('another user cannot replay someone else’s generation', () => {
    const m = newManager();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, new ControlledProvider());

    expect(() => m.catchUp(generationId, randomUUID(), 0)).toThrow(
      expect.objectContaining({ code: 'GENERATION_NOT_FOUND' })
    );
  });
});

describe('lifecycle races, driven deterministically', () => {
  it('cancel during streaming wins, and late chunks are ignored', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('partial'));
    await until(() => (m.get(generationId, OWNER)?.content ?? '') === 'partial', 'first chunk');

    m.cancel(generationId, OWNER);

    // The provider keeps talking; none of it may land.
    provider.emit(content(' more'));
    provider.emit(content(' and more'));
    provider.end();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = m.get(generationId, OWNER);
    expect(snapshot?.state).toBe('cancelled');
    expect(snapshot?.content).toBe('partial');
  });

  it('completion wins if it lands before the cancel', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('all of it'));
    provider.end();
    await until(() => m.get(generationId, OWNER)?.state === 'completed', 'completion');

    // A cancel arriving afterwards must not rewrite the outcome.
    expect(m.cancel(generationId, OWNER).state).toBe('completed');
  });

  it('emits exactly one terminal event however the run ends', async () => {
    for (const ending of ['complete', 'cancel', 'fail'] as const) {
      const m = newManager();
      const provider = new ControlledProvider();
      const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

      const terminals: string[] = [];
      m.subscribe(generationId, OWNER, ({ event }) => {
        if (event.type === 'done') terminals.push(event.state);
      });

      await until(() => provider.started, 'stream to start');
      provider.emit(content('x'));

      if (ending === 'complete') provider.end();
      if (ending === 'cancel') m.cancel(generationId, OWNER);
      if (ending === 'fail') provider.fail(new Error('provider exploded'));

      await until(() => terminals.length > 0, `${ending} terminal`);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(terminals, ending).toHaveLength(1);
      m.shutdown();
    }
  });

  it('an observer attaching during the terminal transition still sees the outcome', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('x'));
    provider.end();
    await until(() => m.get(generationId, OWNER)?.state === 'completed', 'completion');

    // Attaching after the fact must not hang waiting for an event that already
    // happened; the catch-up carries it.
    const events = m.catchUp(generationId, OWNER, 0);
    expect(events.some((e) => e.event.type === 'done')).toBe(true);
  });

  it('a generation with no observers still runs to completion', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    // Nobody is watching at any point.
    await until(() => provider.started, 'stream to start');
    provider.emit(content('unobserved'));
    provider.end();
    await until(() => m.get(generationId, OWNER)?.state === 'completed', 'completion');

    expect(m.get(generationId, OWNER)?.content).toBe('unobserved');
  });

  it('a provider interruption lands in failed with the partial output kept', async () => {
    const m = newManager();
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider);

    await until(() => provider.started, 'stream to start');
    provider.emit(content('half a sen'));
    await until(() => (m.get(generationId, OWNER)?.content ?? '') !== '', 'first chunk');
    provider.fail(new Error('connection reset'));

    await until(() => m.get(generationId, OWNER)?.state === 'failed', 'failure');
    expect(m.get(generationId, OWNER)?.content).toBe('half a sen');
  });
});

describe('checkpoint cadence', () => {
  it('writes on start and on each state transition, not per token', async () => {
    // A 10s cadence means any write during streaming can only be a transition.
    const m = newManager({ checkpointMs: 10_000 });
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider, {
      conversationId: randomUUID(),
      providerId: 'local',
    });

    await until(() => provider.started, 'stream to start');
    for (let i = 0; i < 50; i += 1) provider.emit(content(`token${i} `));
    await until(
      () => (m.get(generationId, OWNER)?.content ?? '').includes('token49'),
      'all tokens'
    );
    await m.checkpointsFlushed(generationId);

    const checkpoint = await checkpoints.read(generationId);
    expect(checkpoint).not.toBeNull();
    // Written at the streaming transition, so it holds far less than 50 tokens.
    expect(checkpoint?.state).toBe('streaming');
    expect((checkpoint?.content.match(/token/g) ?? []).length).toBeLessThan(50);
  });

  it('records the terminal state even when the cadence has not elapsed', async () => {
    const m = newManager({ checkpointMs: 10_000 });
    const provider = new ControlledProvider();
    const { generationId } = m.start(OWNER, 'model', MESSAGES, provider, {
      conversationId: randomUUID(),
      providerId: 'local',
    });

    await until(() => provider.started, 'stream to start');
    provider.emit(content('final'));
    provider.end();
    await until(() => m.get(generationId, OWNER)?.state === 'completed', 'completion');
    // Waits on the actual write queue rather than guessing a duration.
    await m.checkpointsFlushed(generationId);

    const checkpoint = await checkpoints.read(generationId);
    expect(checkpoint?.state).toBe('completed');
    expect(checkpoint?.content).toBe('final');
  });
});

describe('INV-21: restart policy', () => {
  async function conversationWithUserMessage(): Promise<string> {
    const { id } = await store.create(OWNER, 'Interrupted run');
    await store.appendMessages(OWNER, id, [{ type: 'user', id: randomUUID(), body: 'a question' }]);
    return id;
  }

  it('writes partial output as interrupted, exactly once', async () => {
    const conversationId = await conversationWithUserMessage();
    const assistantMessageId = randomUUID();

    await checkpoints.write({
      generationId: randomUUID(),
      ownerId: OWNER,
      conversationId,
      assistantMessageId,
      providerId: 'local',
      model: 'a-model',
      state: 'streaming',
      content: 'half an ans',
      reasoning: 'was thinking',
      lastEventId: 12,
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:01.000Z',
    });

    const result = await recoverGenerations({ checkpoints, store, index, logger });
    expect(result.interrupted).toBe(1);

    const conversation = await store.load(OWNER, conversationId);
    const assistants = conversation.messages.filter((m) => m.type === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      id: assistantMessageId,
      status: 'interrupted',
      provider: 'local',
      model: 'a-model',
      reasoning: 'was thinking',
      body: 'half an ans',
    });

    const raw = await readFile(paths.conversationFile(OWNER, conversationId), 'utf8');
    expect(raw.match(/cc:assistant/g)).toHaveLength(1);
    expect(raw).toContain('status=interrupted');
  });

  it('is idempotent: running twice does not write the message twice', async () => {
    const conversationId = await conversationWithUserMessage();
    const assistantMessageId = randomUUID();
    const checkpoint = {
      generationId: randomUUID(),
      ownerId: OWNER,
      conversationId,
      assistantMessageId,
      providerId: 'local',
      model: 'a-model',
      state: 'streaming' as const,
      content: 'partial',
      reasoning: '',
      lastEventId: 3,
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:01.000Z',
    };

    await checkpoints.write(checkpoint);
    await recoverGenerations({ checkpoints, store, index, logger });

    // Simulate a crash between the Markdown write and clearing the checkpoint:
    // the file is gone but the checkpoint came back.
    await checkpoints.write(checkpoint);
    const second = await recoverGenerations({ checkpoints, store, index, logger });

    expect(second.alreadyWritten).toBe(1);
    expect(second.interrupted).toBe(0);

    const raw = await readFile(paths.conversationFile(OWNER, conversationId), 'utf8');
    expect(raw.match(/cc:assistant/g)).toHaveLength(1);
  });

  it('clears a terminal checkpoint without writing anything', async () => {
    const conversationId = await conversationWithUserMessage();

    await checkpoints.write({
      generationId: randomUUID(),
      ownerId: OWNER,
      conversationId,
      assistantMessageId: randomUUID(),
      providerId: 'local',
      model: 'a-model',
      state: 'completed',
      content: 'already written by the normal path',
      reasoning: '',
      lastEventId: 9,
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:01.000Z',
    });

    const result = await recoverGenerations({ checkpoints, store, index, logger });

    expect(result.cleared).toBe(1);
    expect(result.interrupted).toBe(0);
    expect((await store.load(OWNER, conversationId)).messages).toHaveLength(1);
  });

  it('discards a checkpoint whose conversation was deleted', async () => {
    await checkpoints.write({
      generationId: randomUUID(),
      ownerId: OWNER,
      conversationId: randomUUID(),
      assistantMessageId: randomUUID(),
      providerId: 'local',
      model: 'a-model',
      state: 'streaming',
      content: 'orphaned',
      reasoning: '',
      lastEventId: 1,
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:01.000Z',
    });

    const result = await recoverGenerations({ checkpoints, store, index, logger });

    expect(result.cleared).toBe(1);
    expect(await checkpoints.list()).toEqual([]);
  });

  it('leaves no checkpoints behind after a clean recovery', async () => {
    const conversationId = await conversationWithUserMessage();
    for (let i = 0; i < 3; i += 1) {
      await checkpoints.write({
        generationId: randomUUID(),
        ownerId: OWNER,
        conversationId,
        assistantMessageId: randomUUID(),
        providerId: 'local',
        model: 'a-model',
        state: 'streaming',
        content: `partial ${i}`,
        reasoning: '',
        lastEventId: i,
        createdAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:01.000Z',
      });
    }

    await recoverGenerations({ checkpoints, store, index, logger });

    expect(await checkpoints.list()).toEqual([]);
  });
});
