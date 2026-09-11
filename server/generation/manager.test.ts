import { afterEach, describe, expect, it } from 'vitest';
import type { GenerationEvent, GenerationState } from '@shared/generation.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import {
  startMockProvider,
  type MockProvider,
  type MockProviderOptions,
} from '../provider/mockServer.ts';
import type { Provider, ProviderChunk } from '../provider/types.ts';
import { GenerationManager } from './manager.ts';

const logger = createLogger({ level: 'silent', write: () => {} });

let mock: MockProvider | undefined;
let manager: GenerationManager | undefined;

afterEach(async () => {
  manager?.shutdown();
  manager = undefined;
  await mock?.close();
  mock = undefined;
});

async function withMock(options: MockProviderOptions = {}): Promise<GenerationManager> {
  mock = await startMockProvider(options);
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
  return manager;
}

function withProvider(provider: Provider, options = {}): GenerationManager {
  manager = new GenerationManager({ provider, logger, maxOutputTokens: 128, ...options });
  return manager;
}

const messages = [{ role: 'user' as const, content: 'hi' }];
const OWNER = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

/** Polls until the generation reaches a terminal state, or throws. */
async function settle(
  m: GenerationManager,
  id: string,
  timeoutMs = 5_000
): Promise<GenerationState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = m.get(id, OWNER);
    if (snapshot === null) throw new Error('generation disappeared');
    if (snapshot.state !== 'pending' && snapshot.state !== 'streaming') return snapshot.state;
    if (Date.now() > deadline) throw new Error(`stuck in ${snapshot.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GenerationManager', () => {
  it('completes a generation and keeps reasoning separate', async () => {
    const m = await withMock({ reasoningChunks: ['why '], contentChunks: ['Hello', '!'] });

    const { generationId } = m.start(OWNER, 'GPT', messages);
    await settle(m, generationId);

    const snapshot = m.get(generationId, OWNER);
    expect(snapshot?.state).toBe('completed');
    expect(snapshot?.content).toBe('Hello!');
    expect(snapshot?.reasoning).toBe('why ');
  });

  it('mints distinct generation and assistant message ids', async () => {
    const m = await withMock();

    const { generationId, assistantMessageId } = m.start(OWNER, 'GPT', messages);

    expect(generationId).not.toBe(assistantMessageId);
    expect(generationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
    expect(assistantMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it('INV-05: a cancel during streaming produces exactly one terminal state', async () => {
    const m = await withMock({ chunkDelayMs: 30, contentChunks: ['a', 'b', 'c', 'd', 'e'] });
    const { generationId } = m.start(OWNER, 'GPT', messages);

    const terminals: GenerationState[] = [];
    m.subscribe(generationId, OWNER, ({ event }) => {
      if (event.type === 'done') terminals.push(event.state);
    });

    await new Promise((r) => setTimeout(r, 40));
    m.cancel(generationId, OWNER);
    await settle(m, generationId);
    // Give any late provider chunks a chance to (wrongly) reopen it.
    await new Promise((r) => setTimeout(r, 150));

    expect(terminals).toEqual(['cancelled']);
    expect(m.get(generationId, OWNER)?.state).toBe('cancelled');
  });

  it('INV-05: cancelling an already-completed generation does not change its state', async () => {
    const m = await withMock();
    const { generationId } = m.start(OWNER, 'GPT', messages);
    await settle(m, generationId);

    const after = m.cancel(generationId, OWNER);

    expect(after.state).toBe('completed');
  });

  it('INV-05: a provider failure lands in `failed` exactly once', async () => {
    const m = await withMock({ failWith: { status: 500, message: 'boom' } });
    const { generationId } = m.start(OWNER, 'GPT', messages);

    const state = await settle(m, generationId);

    expect(state).toBe('failed');
    expect(m.get(generationId, OWNER)?.errorCode).toBe('PROVIDER_ERROR');
  });

  it('INV-05: a provider timeout lands in `timed_out`, not `failed`', async () => {
    mock = await startMockProvider({ hang: true });
    const provider = new LlamaCppProvider(
      {
        baseUrl: mock.url,
        apiKey: undefined,
        timeoutMs: 500,
        defaultContextTokens: 8_192,
        maxOutputTokens: 128,
      },
      logger
    );
    const m = withProvider(provider);

    const { generationId } = m.start(OWNER, 'GPT', messages);
    const state = await settle(m, generationId, 4_000);

    expect(state).toBe('timed_out');
  });

  it('INV-05: late chunks after a terminal state are dropped', async () => {
    // A provider that keeps yielding after the manager has finished.
    let yielded = 0;
    const chatty: Provider = {
      name: 'chatty',
      listModels: () => Promise.resolve([]),
      contextLength: () => null,
      async *streamChat(): AsyncIterable<ProviderChunk> {
        for (let i = 0; i < 50; i += 1) {
          yielded += 1;
          yield { type: 'content', text: 'x' };
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    };
    const m = withProvider(chatty);

    const { generationId } = m.start(OWNER, 'any', messages);
    await new Promise((r) => setTimeout(r, 30));
    m.cancel(generationId, OWNER);
    const lengthAtCancel = m.get(generationId, OWNER)?.content.length ?? 0;

    await new Promise((r) => setTimeout(r, 100));

    expect(m.get(generationId, OWNER)?.state).toBe('cancelled');
    expect(m.get(generationId, OWNER)?.content.length).toBe(lengthAtCancel);
    expect(yielded).toBeGreaterThan(0);
  });

  it('INV-06: unsubscribing does not cancel the generation', async () => {
    const m = await withMock({ chunkDelayMs: 20, contentChunks: ['a', 'b', 'c'] });
    const { generationId } = m.start(OWNER, 'GPT', messages);

    const unsubscribe = m.subscribe(generationId, OWNER, () => {});
    await new Promise((r) => setTimeout(r, 25));
    unsubscribe();

    const state = await settle(m, generationId);
    expect(state).toBe('completed');
    expect(m.get(generationId, OWNER)?.content).toBe('abc');
  });

  it('emits events with monotonically increasing ids', async () => {
    const m = await withMock({ contentChunks: ['a', 'b', 'c'] });
    const { generationId } = m.start(OWNER, 'GPT', messages);

    const ids: number[] = [];
    const events: GenerationEvent[] = [];
    m.subscribe(generationId, OWNER, ({ id, event }) => {
      ids.push(id);
      events.push(event);
    });

    await settle(m, generationId);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('INV-15: another user cannot observe or cancel a generation', async () => {
    const m = await withMock({ chunkDelayMs: 30, contentChunks: ['a', 'b', 'c'] });
    const other = '11111111-2222-4333-8444-555566667777';

    const { generationId } = m.start(OWNER, 'GPT', messages);

    // Reported as absent, not forbidden, so a probe cannot tell the difference.
    expect(m.get(generationId, other)).toBeNull();
    expect(() => m.require(generationId, other)).toThrow(
      expect.objectContaining({ code: 'GENERATION_NOT_FOUND' })
    );
    expect(() => m.cancel(generationId, other)).toThrow(
      expect.objectContaining({ code: 'GENERATION_NOT_FOUND' })
    );
    expect(() => m.subscribe(generationId, other, () => {})).toThrow(
      expect.objectContaining({ code: 'GENERATION_NOT_FOUND' })
    );

    // The owner is unaffected by the failed attempts.
    expect(await settle(m, generationId)).toBe('completed');
  });

  it('reports GENERATION_NOT_FOUND for an unknown id', async () => {
    const m = await withMock();

    expect(m.get('missing', OWNER)).toBeNull();
    expect(() => m.require('missing', OWNER)).toThrow(
      expect.objectContaining({ code: 'GENERATION_NOT_FOUND' })
    );
    expect(() => m.cancel('missing', OWNER)).toThrow(
      expect.objectContaining({ code: 'GENERATION_NOT_FOUND' })
    );
  });

  it('evicts terminal generations past the retention window', async () => {
    mock = await startMockProvider();
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
    let clock = new Date('2026-09-11T00:00:00.000Z');
    const m = new GenerationManager({
      provider,
      logger,
      maxOutputTokens: 128,
      retentionMs: 1_000,
      now: () => clock,
    });
    manager = m;

    const first = m.start(OWNER, 'GPT', messages);
    await settle(m, first.generationId);
    expect(m.size).toBe(1);

    clock = new Date(clock.getTime() + 5_000);
    m.start(OWNER, 'GPT', messages); // starting triggers eviction

    expect(m.get(first.generationId, OWNER)).toBeNull();
  });

  it('caps the number of retained generations', async () => {
    const m = await withMock();
    const started = [];
    for (let i = 0; i < 6; i += 1) {
      const g = m.start(OWNER, 'GPT', messages);
      started.push(g.generationId);
      await settle(m, g.generationId);
    }

    // The cap only applies on the next start, so create one more.
    const managerWithCap = new GenerationManager({
      provider: {
        name: 'noop',
        listModels: () => Promise.resolve([]),
        contextLength: () => null,
        async *streamChat() {},
      },
      logger,
      maxOutputTokens: 128,
      maxRetained: 3,
    });
    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const g = managerWithCap.start(OWNER, 'm', messages);
      ids.push(g.generationId);
      await settle(managerWithCap, g.generationId);
    }
    managerWithCap.start(OWNER, 'm', messages);

    expect(managerWithCap.size).toBeLessThanOrEqual(4);
    managerWithCap.shutdown();
  });
});
