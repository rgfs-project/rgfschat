import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { AttachmentStore } from '../attachments/store.ts';
import { pngBytes } from '../attachments/testImages.ts';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { startMockProvider, type MockProvider } from '../provider/mockServer.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * A picture is a message.
 *
 * Sending one with nothing typed beside it did nothing at all: the composer
 * enabled Send on "text *or* an attachment", and everything behind it required
 * text. The only way through was to type something meaningless, which was then
 * shown under the image and used as the conversation's title.
 *
 * The rule is now one predicate — text, or at least one attachment — and it is
 * checked in all three places that decide: the composer, the request schema,
 * and the method that writes the message.
 */

/*
 * Each test boots an HTTP server, a mock provider, a provider refresh and an
 * argon2 account. That is comfortably fast on its own and can outlast the
 * default five seconds when the whole suite is running in parallel around it,
 * which shows up as two or three tests timing out at random.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let server: Server | undefined;
let base: string;
let mock: MockProvider | undefined;
let store: ConversationStore;
let attachments: AttachmentStore;
let reader: TestClient;

/** `GPT` is advertised as text-only, `Qwen Mini` as text and image. */
const VISION_MODEL = 'Qwen Mini';
const TEXT_ONLY_MODEL = 'GPT';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'attachment-only-'));
  const paths = new StoragePaths(dataDir);

  mock = await startMockProvider({ contentChunks: ['I can see it.'] });
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

  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  attachments = new AttachmentStore(paths, {
    maxBytes: 1_000_000,
    maxTotalBytesPerUser: 8_000_000,
    pendingTtlMs: 60_000,
    maxImagePixels: 50_000_000,
  });

  const manager = new GenerationManager({ provider, logger, maxOutputTokens: 128 });
  const hub = new ProviderHub({
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
      baseUrl: mock.url,
      timeoutMs: 5_000,
      capabilities: {},
    },
  ]);
  await hub.refresh();

  const service = new GenerationService({
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    attachments,
  });

  const app = createApp({
    logger,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    store,
    index,
    manager,
    hub,
    service,
    attachments,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const account = await users.create({ username: 'reader', password: 'a-good-password' });
  reader = await signIn(base, sessions, account.id);
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await mock?.close();
  mock = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

/** An uploaded, unattached image, as the composer would have left it. */
async function uploadImage(filename = 'diagram.png'): Promise<string> {
  const bytes = pngBytes(16, 16);
  const { meta } = await attachments.create(reader.userId, filename, {
    // eslint-disable-next-line @typescript-eslint/require-await -- the bytes are already in hand
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(bytes);
    },
  });
  return meta.id;
}

async function newConversation(): Promise<string> {
  const response = await reader.fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return ((await response.json()) as { id: string }).id;
}

interface SendOptions {
  content?: string;
  attachmentIds?: string[];
  model?: string;
}

async function send(conversationId: string, options: SendOptions = {}): Promise<Response> {
  return reader.fetch('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      providerId: 'local',
      model: options.model ?? VISION_MODEL,
      content: options.content ?? '',
      ...(options.attachmentIds === undefined ? {} : { attachmentIds: options.attachmentIds }),
    }),
  });
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** Waits for the generation to be written back into the conversation. */
async function settled(conversationId: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const conversation = await store.load(reader.userId, conversationId);
    if (conversation.messages.some((message) => message.type === 'assistant')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the generation never landed');
}

describe('a message that is only an attachment', () => {
  it('is accepted', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    const response = await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    expect(response.status).toBe(202);
  });

  it('is persisted with an empty body and the attachment on it', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    const [message] = (await store.load(reader.userId, conversationId)).messages;
    expect(message).toMatchObject({ type: 'user', body: '', attachments: [image] });
  });

  /* No invented text anywhere in the record: not "[Image]", not the filename. */
  it('puts no placeholder text in the stored message', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage('holiday-snap.png');

    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    const [message] = (await store.load(reader.userId, conversationId)).messages;
    expect((message as { body: string }).body).toBe('');
  });

  it('survives the round trip through the Markdown on disk', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();
    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    // Read back from the file, not from memory.
    const reloaded = await store.load(reader.userId, conversationId);
    expect(reloaded.messages[0]).toMatchObject({
      type: 'user',
      body: '',
      attachments: [image],
    });
  });

  it('carries several attachments with no text', async () => {
    const conversationId = await newConversation();
    const first = await uploadImage('one.png');
    const second = await uploadImage('two.png');

    const response = await send(conversationId, { attachmentIds: [first, second] });
    await settled(conversationId);

    expect(response.status).toBe(202);
    expect((await store.load(reader.userId, conversationId)).messages[0]).toMatchObject({
      attachments: [first, second],
    });
  });

  /*
   * What actually reaches the provider. An empty text part is refused by some
   * OpenAI-compatible servers and silently answered as "nothing was asked" by
   * others, so the request carries a neutral sentence — which exists only in
   * the request.
   */
  it('sends the image to the provider, with a neutral part in place of the text', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    const body = mock?.requests.at(-1)?.body as {
      messages: { role: string; content: { type: string; text?: string }[] }[];
    };
    const user = body.messages.findLast((message) => message.role === 'user');
    expect(user?.content.some((part) => part.type === 'image_url')).toBe(true);

    const text = user?.content.find((part) => part.type === 'text')?.text ?? '';
    expect(text.trim()).not.toBe('');
  });

  it('keeps the neutral part out of the conversation', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    const body = mock?.requests.at(-1)?.body as {
      messages: { role: string; content: { type: string; text?: string }[] }[];
    };
    const sent = body.messages
      .findLast((message) => message.role === 'user')
      ?.content.find((part) => part.type === 'text')?.text;

    const [message] = (await store.load(reader.userId, conversationId)).messages;
    expect((message as { body: string }).body).not.toBe(sent);
    expect((message as { body: string }).body).toBe('');
  });
});

describe('what is still refused', () => {
  it('a message with neither text nor an attachment', async () => {
    const conversationId = await newConversation();

    const response = await send(conversationId, { content: '   ' });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('VALIDATION');
  });

  it('an empty message with an empty attachment list', async () => {
    const conversationId = await newConversation();

    const response = await send(conversationId, { content: '', attachmentIds: [] });

    expect(response.status).toBe(400);
  });

  it('writes nothing when it is refused', async () => {
    const conversationId = await newConversation();

    await send(conversationId, { content: '' });

    expect((await store.load(reader.userId, conversationId)).messages).toEqual([]);
  });

  it('an attachment the chosen model cannot read', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    const response = await send(conversationId, {
      attachmentIds: [image],
      model: TEXT_ONLY_MODEL,
    });

    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('MODEL_CAPABILITY_UNSUPPORTED');
    // Refused before anything was written, so the attachment is still the
    // reader's to send to a model that can read it.
    expect((await store.load(reader.userId, conversationId)).messages).toEqual([]);
    expect(await attachments.read(reader.userId, image)).toMatchObject({ messageId: null });
  });

  it('an attachment that belongs to another message already', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();
    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    // A second conversation, so the refusal can only be about the attachment:
    // sending into the same one while its generation still runs is refused for
    // being in progress, which is a different rule.
    const second = await send(await newConversation(), { attachmentIds: [image] });

    expect(second.status).toBe(400);
  });
});

describe('text, with and without an attachment', () => {
  it('still sends text on its own', async () => {
    const conversationId = await newConversation();

    const response = await send(conversationId, { content: 'just words' });
    await settled(conversationId);

    expect(response.status).toBe(202);
    expect((await store.load(reader.userId, conversationId)).messages[0]).toMatchObject({
      body: 'just words',
    });
  });

  it('still sends text with an image', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    const response = await send(conversationId, {
      content: 'what is this?',
      attachmentIds: [image],
    });
    await settled(conversationId);

    expect(response.status).toBe(202);
    expect((await store.load(reader.userId, conversationId)).messages[0]).toMatchObject({
      body: 'what is this?',
      attachments: [image],
    });
  });

  it('sends the reader’s own words when there are any', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    await send(conversationId, { content: 'what is this?', attachmentIds: [image] });
    await settled(conversationId);

    const body = mock?.requests.at(-1)?.body as {
      messages: { role: string; content: { type: string; text?: string }[] }[];
    };
    const text = body.messages
      .findLast((message) => message.role === 'user')
      ?.content.find((part) => part.type === 'text')?.text;

    expect(text).toBe('what is this?');
  });
});

/*
 * The title comes from what the reader wrote. An attachment-only opening turn
 * has nothing to take, and inventing something — the filename, a placeholder,
 * the attachment's id — would put words in their mouth or leak an internal id
 * into the sidebar.
 */
describe('the title of a conversation that opens with an attachment', () => {
  it('stays the default rather than being invented', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage('IMG_4021.png');

    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    const { title } = await store.load(reader.userId, conversationId);
    expect(title).toBe('New conversation');
    expect(title).not.toContain(image);
    expect(title).not.toContain('IMG_4021');
  });

  it('is taken from the first turn that does have words', async () => {
    const conversationId = await newConversation();
    const image = await uploadImage();

    await send(conversationId, { attachmentIds: [image] });
    await settled(conversationId);

    await send(conversationId, { content: 'what is in the picture?' });
    for (let i = 0; i < 300; i += 1) {
      const { title } = await store.load(reader.userId, conversationId);
      if (title !== 'New conversation') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect((await store.load(reader.userId, conversationId)).title).toBe('what is in the picture?');
  });
});
