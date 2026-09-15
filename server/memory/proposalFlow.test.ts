import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { startMockProvider, type MockProvider } from '../provider/mockServer.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { MemoryStore } from '../storage/memories.ts';
import { StoragePaths } from '../storage/paths.ts';
import { ProposalStore } from '../storage/proposals.ts';

/**
 * The whole path, end to end: a model asks for a memory change and the change
 * does not happen.
 *
 * That last part is the assertion worth having. Everything else here — the
 * stream reassembly, the argument validation, the file the proposal lands in —
 * is in service of one property: a memory is prepended to the system prompt of
 * every later generation, so a model that could write one unattended could hand
 * itself a durable instruction, and any text it reads is a way to make it try.
 * Nothing but a person accepting may close that gap.
 */

const logger = createLogger({ level: 'silent', write: () => {} });
const USER = '11111111-1111-4111-8111-111111111111';

let dir: string;
let mock: MockProvider | undefined;
let store: ConversationStore;
let index: ChatIndex;
let manager: GenerationManager;
let hub: ProviderHub;
let memories: MemoryStore;
let proposals: ProposalStore;
let service: GenerationService;

/** The service options every test shares, so one test can drop a single key. */
function serviceOptions(): ConstructorParameters<typeof GenerationService>[0] {
  return {
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    memories,
  };
}

async function boot(
  toolCalls: { id: string; name: string; argumentChunks: string[] }[]
): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'proposal-flow-'));
  const paths = new StoragePaths(dir);

  mock = await startMockProvider({ contentChunks: ['Noted.'], toolCalls });
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

  store = new ConversationStore({ paths, logger });
  index = new ChatIndex({ store, logger });
  memories = new MemoryStore(paths, logger);
  proposals = new ProposalStore(paths, logger);
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
      baseUrl: mock.url,
      timeoutMs: 5_000,
      capabilities: {},
    },
  ]);

  service = new GenerationService({ ...serviceOptions(), proposals });
}

/** Runs one turn and resolves once the assistant block and proposals have landed. */
async function ask(): Promise<string> {
  const { id } = await store.create(USER, 'Test');
  await service.start(USER, id, 'local', 'GPT', 'remember my coffee order');
  await service.settled(USER, id);
  return id;
}

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('a model asking to save a memory', () => {
  beforeEach(async () => {
    await boot([
      {
        id: 'call_1',
        name: 'remember',
        argumentChunks: ['{"name":"coffee-ord', 'er","content":"Drinks flat whites."}'],
      },
    ]);
  });

  it('records it as a proposal against the turn that asked', async () => {
    const id = await ask();

    expect(await proposals.list(USER, id)).toMatchObject([
      { operation: 'create', name: 'coffee-order', content: 'Drinks flat whites.' },
    ]);
  });

  it('writes no memory', async () => {
    await ask();

    expect(await memories.list(USER)).toEqual([]);
  });

  it('still records the reply the model gave alongside the call', async () => {
    const id = await ask();

    const conversation = await store.load(USER, id);
    expect(conversation.messages.at(-1)).toMatchObject({ type: 'assistant', body: 'Noted.' });
  });

  it('points the proposal at the assistant message, so the UI can place it', async () => {
    const id = await ask();

    const conversation = await store.load(USER, id);
    const assistant = conversation.messages.at(-1);
    const [proposal] = await proposals.list(USER, id);

    expect(proposal?.assistantMessageId).toBe(assistant?.id);
  });

  it('writes the memory only once the proposal is taken and applied', async () => {
    const id = await ask();
    const [proposal] = await proposals.list(USER, id);

    const taken = await proposals.take(USER, id, proposal?.id as string);
    await memories.write(USER, taken?.name as string, taken?.content as string);

    expect(await memories.list(USER)).toMatchObject([
      { name: 'coffee-order', content: 'Drinks flat whites.' },
    ]);
    expect(await proposals.list(USER, id)).toEqual([]);
  });

  it('offers the tools to the provider', async () => {
    await ask();

    const body = mock?.requests.at(-1)?.body as { tools?: { function: { name: string } }[] };
    expect(body.tools?.map((tool) => tool.function.name)).toEqual([
      'remember',
      'update_memory',
      'forget_memory',
    ]);
  });
});

describe('a model asking for something malformed', () => {
  it('drops the call without touching the reply', async () => {
    await boot([
      // A traversal in the name, which `isMemoryName` refuses.
      { id: 'call_1', name: 'remember', argumentChunks: ['{"name":"../../x","content":"y"}'] },
    ]);

    const id = await ask();

    expect(await proposals.list(USER, id)).toEqual([]);
    expect(await memories.list(USER)).toEqual([]);
    const conversation = await store.load(USER, id);
    expect(conversation.messages.at(-1)).toMatchObject({ status: 'complete', body: 'Noted.' });
  });

  it('ignores a tool it never offered', async () => {
    await boot([{ id: 'call_1', name: 'read_file', argumentChunks: ['{"path":"/etc/passwd"}'] }]);

    const id = await ask();

    expect(await proposals.list(USER, id)).toEqual([]);
  });
});

describe('with no proposal store configured', () => {
  /* Its absence is what turns the feature off, so a server that has not opted
     in sends exactly the request it sent before any of this existed. */
  it('sends no tools at all', async () => {
    await boot([]);
    service = new GenerationService(serviceOptions());

    await ask();

    expect(mock?.requests.at(-1)?.body).not.toHaveProperty('tools');
  });
});

describe('the proposal id namespace', () => {
  it('does not leak one conversation’s proposals into another', async () => {
    await boot([
      { id: 'call_1', name: 'remember', argumentChunks: ['{"name":"a","content":"A"}'] },
    ]);

    const first = await ask();
    const second = await store.create(USER, 'Other');

    expect(await proposals.list(USER, first)).toHaveLength(1);
    expect(await proposals.list(USER, second.id)).toEqual([]);
    expect(await proposals.take(USER, second.id, randomUUID())).toBeNull();
  });
});

/**
 * The clock placeholders, end to end.
 *
 * Asserted against what actually left for the provider, not against the
 * substitution function — the function has its own unit tests, and what this
 * one is for is proving the wiring reaches the request body.
 */
describe('system prompt placeholders', () => {
  const systemPromptOf = (): string => {
    const body = mock?.requests.at(-1)?.body as { messages: { role: string; content: string }[] };
    return body.messages.find((m) => m.role === 'system')?.content ?? '';
  };

  async function bootWithPrompt(template: string): Promise<void> {
    await boot([]);
    service = new GenerationService({
      ...serviceOptions(),
      settings: { samplerFor: () => ({ systemPrompt: template }) },
      users: { usernameFor: () => Promise.resolve('ada') },
      now: () => new Date('2026-09-14T14:30:00Z'),
    });
  }

  it('fills the clock and the name in the prompt that is sent', async () => {
    await bootWithPrompt('Today is {{CURRENT_WEEKDAY}}. Speak to {{USER_NAME}}.');

    const { id } = await store.create(USER, 'Test');
    await service.start(USER, id, 'local', 'GPT', 'hello', [], 'UTC');
    await service.settled(USER, id);

    expect(systemPromptOf()).toContain('Today is Monday. Speak to ada.');
  });

  it('uses the zone the client sent, not the server’s', async () => {
    await bootWithPrompt('{{CURRENT_TIMEZONE}}');

    const { id } = await store.create(USER, 'Test');
    await service.start(USER, id, 'local', 'GPT', 'hello', [], 'Asia/Tokyo');
    await service.settled(USER, id);

    expect(systemPromptOf()).toContain('Asia/Tokyo');
  });

  it('falls back to UTC when the client sent no zone', async () => {
    await bootWithPrompt('{{CURRENT_TIMEZONE}}');

    const { id } = await store.create(USER, 'Test');
    await service.start(USER, id, 'local', 'GPT', 'hello');
    await service.settled(USER, id);

    expect(systemPromptOf()).toContain('UTC');
  });

  /* Memories are the reader's own words. A note that happens to contain double
     braces is a note, not a template. */
  it('does not rewrite placeholders inside a memory', async () => {
    await bootWithPrompt('Be brief.');
    await memories.write(USER, 'style', 'Writes {{CURRENT_DATETIME}} in their notes.');

    const { id } = await store.create(USER, 'Test');
    await service.start(USER, id, 'local', 'GPT', 'hello', [], 'UTC');
    await service.settled(USER, id);

    expect(systemPromptOf()).toContain('{{CURRENT_DATETIME}}');
  });

  it('leaves a prompt with no placeholders untouched', async () => {
    await bootWithPrompt('Be concise.');

    const { id } = await store.create(USER, 'Test');
    await service.start(USER, id, 'local', 'GPT', 'hello', [], 'UTC');
    await service.settled(USER, id);

    expect(systemPromptOf()).toContain('Be concise.');
  });
});
