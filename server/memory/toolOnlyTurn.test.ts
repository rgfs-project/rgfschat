import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import {
  startMockProvider,
  type MockProvider,
  type MockProviderOptions,
} from '../provider/mockServer.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { MemoryStore } from '../storage/memories.ts';
import { StoragePaths } from '../storage/paths.ts';
import { ProposalStore } from '../storage/proposals.ts';

/**
 * The turn that appeared to stop mid-thought.
 *
 * A model asked to remember something would emit its reasoning, call the tool,
 * and finish with no content at all — because nothing ever answered the call.
 * What the reader got was a complete assistant message with an empty body: the
 * reasoning, and then nothing, with the proposal card turning up only on some
 * later reload.
 *
 * Three things had to be true to fix it, and each is asserted below: the turn
 * answers the call and says something; a completed turn is never blank; and the
 * client is not told the run finished until the message and its proposals are
 * both on disk.
 */

const logger = createLogger({ level: 'silent', write: () => {} });
const USER = '11111111-1111-4111-8111-111111111111';

let dir: string;
let mock: MockProvider | undefined;
let store: ConversationStore;
let memories: MemoryStore;
let proposals: ProposalStore;
let manager: GenerationManager;
let service: GenerationService;

/** The call the reported conversation actually made. */
const REMEMBER_JOHN = {
  id: 'call_1',
  name: 'remember',
  argumentChunks: ['{"name":"people-john",', '"content":"Has a brother named John."}'],
};

async function boot(options: MockProviderOptions): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'tool-only-'));
  const paths = new StoragePaths(dir);

  mock = await startMockProvider(options);
  const provider = new LlamaCppProvider(
    {
      baseUrl: mock.url,
      apiKey: undefined,
      timeoutMs: 5_000,
      defaultContextTokens: 8_192,
      maxOutputTokens: 256,
    },
    logger
  );

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  memories = new MemoryStore(paths, logger);
  proposals = new ProposalStore(paths, logger);
  manager = new GenerationManager({ provider, logger, maxOutputTokens: 256 });

  const hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 256,
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

  service = new GenerationService({
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 256,
    memories,
    proposals,
  });
}

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function ask(): Promise<{ conversationId: string; generationId: string }> {
  const { id } = await store.create(USER, 'Test');
  const { generationId } = await service.start(
    USER,
    id,
    'local',
    'GPT',
    'I have a brother named John'
  );
  await service.settled(USER, id);
  return { conversationId: id, generationId };
}

/** The chat requests that actually reached the provider, excluding discovery. */
function chatRequests(): { body: unknown }[] {
  return (mock?.requests ?? []).filter((request) => request.path.includes('chat/completions'));
}

/*
 * The exact stream from the report: reasoning, a valid call, finish_reason
 * tool_calls, and not one character of content.
 */
describe('reasoning, a tool call, and no content', () => {
  const stream: MockProviderOptions = {
    reasoningChunks: ['The user says they have a brother named John. ', 'I should save a note.'],
    contentChunks: [],
    toolCalls: [REMEMBER_JOHN],
    finishReason: 'tool_calls',
  };

  it('persists exactly one assistant message', async () => {
    await boot(stream);

    const { conversationId } = await ask();

    const assistants = (await store.load(USER, conversationId)).messages.filter(
      (message) => message.type === 'assistant'
    );
    expect(assistants).toHaveLength(1);
  });

  it('persists exactly one proposal', async () => {
    await boot(stream);

    const { conversationId } = await ask();

    expect(await proposals.list(USER, conversationId)).toMatchObject([
      { operation: 'create', name: 'people-john' },
    ]);
  });

  /* The heart of it: a complete turn is never a blank one. */
  it('leaves no completed assistant message with an empty body', async () => {
    await boot(stream);

    const { conversationId } = await ask();

    const assistant = (await store.load(USER, conversationId)).messages.at(-1);
    expect(assistant).toMatchObject({ status: 'complete' });
    expect((assistant as { body: string }).body.trim()).not.toBe('');
  });

  it('does not pass the reasoning off as the answer', async () => {
    await boot(stream);

    const { conversationId } = await ask();

    const assistant = (await store.load(USER, conversationId)).messages.at(-1) as {
      body: string;
      reasoning?: string;
    };
    expect(assistant.reasoning).toContain('brother named John');
    expect(assistant.body).not.toContain('I should save a note');
  });

  it('points the proposal at the message that was persisted', async () => {
    await boot(stream);

    const { conversationId } = await ask();

    const assistant = (await store.load(USER, conversationId)).messages.at(-1);
    const [proposal] = await proposals.list(USER, conversationId);
    expect(proposal?.assistantMessageId).toBe(assistant?.id);
  });

  /*
   * The race the card used to lose. `done` is what makes the client refetch,
   * so by the time it is emitted the conversation and the proposals must both
   * be readable — otherwise the refetch returns the reply without its card.
   */
  it('emits the terminal event only once both are readable', async () => {
    await boot(stream);

    const { id } = await store.create(USER, 'Test');
    const { generationId } = await service.start(USER, id, 'local', 'GPT', 'remember this');

    const atDone = new Promise<{ messages: number; proposals: number }>((resolve) => {
      const off = manager.subscribe(generationId, USER, ({ event }) => {
        if (event.type !== 'done') return;
        off();
        void (async () => {
          resolve({
            messages: (await store.load(USER, id)).messages.filter((m) => m.type === 'assistant')
              .length,
            proposals: (await proposals.list(USER, id)).length,
          });
        })();
      });
    });

    expect(await atDone).toEqual({ messages: 1, proposals: 1 });
    await service.settled(USER, id);
  });

  it('answers the call before it takes the follow-up turn', async () => {
    await boot(stream);

    await ask();

    // The second request is the continuation: it carries the tool result, and
    // offers no tools at all, which is what bounds the loop.
    expect(chatRequests()).toHaveLength(2);
    const followUp = chatRequests().at(-1)?.body as {
      messages: { role: string; tool_call_id?: string }[];
      tools?: unknown;
    };
    expect(followUp.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(followUp.tools).toBeUndefined();
  });

  it('takes exactly one follow-up turn, however many calls it made', async () => {
    await boot({
      ...stream,
      toolCalls: [
        REMEMBER_JOHN,
        { id: 'call_2', name: 'remember', argumentChunks: ['{"name":"pets","content":"A dog."}'] },
      ],
    });

    await ask();

    expect(chatRequests()).toHaveLength(2);
  });
});

describe('a tool call alongside a normal reply', () => {
  it('keeps the model’s own words and still files the proposal', async () => {
    await boot({
      contentChunks: ['I’ll remember that.'],
      toolCalls: [REMEMBER_JOHN],
      finishReason: 'tool_calls',
    });

    const { conversationId } = await ask();

    expect((await store.load(USER, conversationId)).messages.at(-1)).toMatchObject({
      body: 'I’ll remember that.',
    });
    expect(await proposals.list(USER, conversationId)).toHaveLength(1);
  });

  it('takes no follow-up turn, having already spoken', async () => {
    await boot({
      contentChunks: ['I’ll remember that.'],
      toolCalls: [REMEMBER_JOHN],
      finishReason: 'tool_calls',
    });

    await ask();

    expect(chatRequests()).toHaveLength(1);
  });
});

describe('a malformed call', () => {
  it('files no proposal and still leaves a visible turn', async () => {
    await boot({
      contentChunks: [],
      toolCalls: [{ id: 'call_1', name: 'remember', argumentChunks: ['{"name":"../etc"}'] }],
      finishReason: 'tool_calls',
    });

    const { conversationId } = await ask();

    expect(await proposals.list(USER, conversationId)).toEqual([]);
    const assistant = (await store.load(USER, conversationId)).messages.at(-1) as { body: string };
    expect(assistant.body.trim()).not.toBe('');
  });
});

/*
 * Idempotency by the identity of the call, not by how many times something
 * happened to look at it.
 */
describe('the same call seen twice', () => {
  it('is one proposal, however often the completion is processed', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId, generationId } = await ask();
    const [first] = await proposals.list(USER, conversationId);

    // Exactly what a reprocessed completion, a reconnect or a recovery pass
    // does: the same generation, the same call, filed again.
    await proposals.add(USER, conversationId, [
      {
        assistantMessageId: first?.assistantMessageId as string,
        operation: 'create',
        name: 'people-john',
        content: 'Has a brother named John.',
        sourceId: `${generationId}:call_1`,
      },
    ]);

    expect(await proposals.list(USER, conversationId)).toHaveLength(1);
  });

  it('is two proposals for two different runs, which are two questions', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId, generationId } = await ask();
    const [first] = await proposals.list(USER, conversationId);

    await proposals.add(USER, conversationId, [
      {
        assistantMessageId: first?.assistantMessageId as string,
        operation: 'create',
        name: 'people-john',
        content: 'Has a brother named John.',
        sourceId: `${generationId}-other:call_1`,
      },
    ]);

    expect(await proposals.list(USER, conversationId)).toHaveLength(2);
  });
});

/*
 * The state the reported data was in: several proposals for one memory, one of
 * them naming an assistant message the conversation no longer had.
 */
describe('regenerating a turn that made a proposal', () => {
  it('takes the replaced turn’s proposals with it', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId } = await ask();
    const [before] = await proposals.list(USER, conversationId);
    expect(before).toBeDefined();

    await service.regenerate(USER, conversationId, 'local', 'GPT');
    await service.settled(USER, conversationId);

    const after = await proposals.list(USER, conversationId);
    // One proposal, from the new turn — not two, and not the old one.
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before?.id);
  });

  it('leaves every proposal naming a message the conversation still has', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId } = await ask();
    await service.regenerate(USER, conversationId, 'local', 'GPT');
    await service.settled(USER, conversationId);

    const present = new Set((await store.load(USER, conversationId)).messages.map((m) => m.id));
    for (const proposal of await proposals.list(USER, conversationId)) {
      expect(present.has(proposal.assistantMessageId)).toBe(true);
    }
  });
});

describe('accepting or rejecting what was proposed', () => {
  it('writes the memory on acceptance and clears the card', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId } = await ask();
    const [proposal] = await proposals.list(USER, conversationId);

    const answered = await proposals.resolve(
      USER,
      conversationId,
      proposal?.id as string,
      (taken) => memories.write(USER, taken.name, taken.content as string, { mode: 'create' })
    );

    expect(answered).not.toBeNull();
    expect(await memories.read(USER, 'people-john')).toMatchObject({
      content: 'Has a brother named John.',
    });
    expect(await proposals.list(USER, conversationId)).toEqual([]);
  });

  it('keeps the card when the write fails', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId } = await ask();
    const [proposal] = await proposals.list(USER, conversationId);
    // Taken by something else since the proposal was made.
    await memories.write(USER, 'people-john', 'Something the reader wrote.');

    await expect(
      proposals.resolve(USER, conversationId, proposal?.id as string, (taken) =>
        memories.write(USER, taken.name, taken.content as string, { mode: 'create' })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await proposals.list(USER, conversationId)).toMatchObject([{ id: proposal?.id }]);
    expect(await memories.read(USER, 'people-john')).toMatchObject({
      content: 'Something the reader wrote.',
    });
  });

  it('writes nothing on rejection', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { conversationId } = await ask();
    const [proposal] = await proposals.list(USER, conversationId);

    await proposals.take(USER, conversationId, proposal?.id as string);

    expect(await memories.list(USER)).toEqual([]);
    expect(await proposals.list(USER, conversationId)).toEqual([]);
  });
});

describe('the stream a reconnecting client replays', () => {
  it('carries one terminal event, not two', async () => {
    await boot({ contentChunks: [], toolCalls: [REMEMBER_JOHN], finishReason: 'tool_calls' });

    const { id } = await store.create(USER, 'Test');
    const { generationId } = await service.start(USER, id, 'local', 'GPT', 'remember this');
    await service.settled(USER, id);

    // What a reconnecting client is sent when it replays from the start.
    const replayed = manager.catchUp(generationId, USER, 0).map((envelope) => envelope.event.type);

    expect(replayed.filter((type) => type === 'done')).toHaveLength(1);
    expect(await proposals.list(USER, id)).toHaveLength(1);
  });
});
