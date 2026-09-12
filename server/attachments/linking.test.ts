import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@shared/attachment.ts';
import { AppError } from '../errors/AppError.ts';
import { createLogger } from '../logger.ts';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { EchoProvider } from '../provider/echoProvider.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';
import { AttachmentStore } from './store.ts';

/**
 * What a message is allowed to carry, checked where it is decided.
 *
 * These go through the generation service rather than the store, because the
 * rules being tested are the service's: how many, whose, and whether the model
 * can read them. The store knows about one attachment at a time.
 *
 * `EchoProvider` reports `echo-small` as text-only and `echo-large` as taking
 * images, which is the split these tests need.
 */

const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let store: ConversationStore;
let attachments: AttachmentStore;
let service: GenerationService;
let manager: GenerationManager;

// eslint-disable-next-line @typescript-eslint/require-await -- stands in for a request stream
async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'attachment-linking-'));
  const paths = new StoragePaths(dataDir);

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  attachments = new AttachmentStore(paths, {
    maxBytes: 1_000_000,
    maxTotalBytesPerUser: 10_000_000,
    pendingTtlMs: 60_000,
  });
  await attachments.ensureUserDir(USER);
  await attachments.ensureUserDir(OTHER);

  manager = new GenerationManager({ logger, maxOutputTokens: 128 });
  const hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    factory: () => new EchoProvider(),
  });
  hub.setProviders([
    {
      id: 'local',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080',
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
    attachments,
    maxInlineChars: 1_000,
  });
});

afterEach(async () => {
  // Generation output is persisted *after* the terminal state, so tearing the
  // directory down on `whenTerminal` alone races the index write that follows
  // it. `allSettled` is the service's own answer to that.
  await service.allSettled();
  manager.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

/** Starts a generation and returns the error it refused with. */
async function refusal(ids: string[], model = 'echo-large'): Promise<AppError> {
  const { id } = await store.create(USER, 'Test');
  try {
    await service.start(USER, id, 'local', model, 'here you go', ids);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the generation to be refused');
}

/**
 * Starts a generation and waits for it to finish.
 *
 * Awaited rather than left running: the echo provider writes the reply
 * asynchronously, and a test that returned while that was in flight would tear
 * its data directory down underneath a live write. `whenTerminal` is the
 * deterministic wait — no polling, no sleep.
 */
async function complete(
  conversationId: string,
  model: string,
  ids: string[]
): Promise<{ generationId: string; userMessageId: string }> {
  const result = await service.start(USER, conversationId, 'local', model, 'here', ids);
  await manager.whenTerminal(result.generationId);
  // And the write that follows it, so the conversation on disk is final.
  await service.allSettled();
  return result;
}

/** Whether the conversation ended up with any message in it. */
async function messageCount(conversationId: string): Promise<number> {
  return (await store.load(USER, conversationId)).messages.length;
}

describe('how many a message may carry', () => {
  it(`refuses more than ${MAX_ATTACHMENTS_PER_MESSAGE}`, async () => {
    const ids: string[] = [];
    for (let i = 0; i <= MAX_ATTACHMENTS_PER_MESSAGE; i += 1) {
      ids.push((await attachments.create(USER, `f${i}.txt`, once(utf8('x')))).meta.id);
    }

    const error = await refusal(ids);

    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/at most/i);
  });

  it('accepts exactly the limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i += 1) {
      ids.push((await attachments.create(USER, `f${i}.txt`, once(utf8('x')))).meta.id);
    }

    const { id } = await store.create(USER, 'Test');
    const result = await complete(id, 'echo-large', ids);

    expect(result.generationId).toBeTruthy();
    // All ten are now part of that message, and none is pending.
    for (const attachmentId of ids) {
      expect((await attachments.read(USER, attachmentId)).messageId).toBe(result.userMessageId);
    }
  });

  it('refuses the same attachment listed twice', async () => {
    const { meta } = await attachments.create(USER, 'once.txt', once(utf8('x')));

    const error = await refusal([meta.id, meta.id]);

    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/twice/i);
  });
});

describe('whose they are', () => {
  it("INV-15: cannot attach another user's file, and is told it does not exist", async () => {
    const { meta } = await attachments.create(OTHER, 'theirs.txt', once(utf8('secret')));

    const error = await refusal([meta.id]);

    // 404, not 403: the refusal must not confirm the id exists.
    expect(error.code).toBe('NOT_FOUND');
    expect((await attachments.read(OTHER, meta.id)).messageId).toBeNull();
  });

  it('cannot attach a file that already belongs to a message', async () => {
    const { meta } = await attachments.create(USER, 'used.txt', once(utf8('x')));
    await attachments.link(USER, [meta.id], randomUUID(), randomUUID());

    const error = await refusal([meta.id]);

    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/already part of a message/i);
  });

  it('cannot attach an id that never existed', async () => {
    expect((await refusal([randomUUID()])).code).toBe('NOT_FOUND');
  });
});

describe('whether the model can read them', () => {
  it('refuses an image for a model that cannot see, before persisting anything', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    const { id } = await store.create(USER, 'Test');

    await expect(
      service.start(USER, id, 'local', 'echo-small', 'look', [meta.id])
    ).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNSUPPORTED' });

    /*
     * The whole point of checking before the write: the conversation must not
     * be left holding a question the model could never have answered.
     */
    expect(await messageCount(id)).toBe(0);
    expect((await attachments.read(USER, meta.id)).messageId).toBeNull();
  });

  it('allows a text file with the same model, since text needs no modality', async () => {
    const { meta } = await attachments.create(USER, 'notes.txt', once(utf8('read me')));
    const { id } = await store.create(USER, 'Test');

    const result = await complete(id, 'echo-small', [meta.id]);

    expect(result.generationId).toBeTruthy();
    expect(await messageCount(id)).toBeGreaterThan(0);
  });

  it('allows an image for a model that can see', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    const { id } = await store.create(USER, 'Test');

    const result = await complete(id, 'echo-large', [meta.id]);

    expect((await attachments.read(USER, meta.id)).messageId).toBe(result.userMessageId);
  });
});

describe('what reaches canonical storage', () => {
  it('writes the ids into the message, so the Markdown is the link', async () => {
    const first = await attachments.create(USER, 'a.txt', once(utf8('a')));
    const second = await attachments.create(USER, 'b.png', once(PNG));
    const { id } = await store.create(USER, 'Test');

    await complete(id, 'echo-large', [first.meta.id, second.meta.id]);

    const conversation = await store.load(USER, id);
    const user = conversation.messages.find((message) => message.type === 'user');
    expect(user?.attachments).toEqual([first.meta.id, second.meta.id]);
  });
});
