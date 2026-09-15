import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GenerationManager } from './manager.ts';
import { GenerationService } from './service.ts';
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
import { ArtifactStore } from '../storage/artifacts.ts';
import { StoragePaths } from '../storage/paths.ts';
import { CAPTURED_EXTENSIONS } from '@shared/artifactBlocks.ts';

/**
 * Files a reply presented, saved once the reply is finished.
 *
 * The rules being asserted are all about *when* nothing happens: not from a
 * fence nobody named, not from a filename in a sentence, not from a run that
 * was cancelled or failed, and never twice for the same turn. The one positive
 * case — a completed reply that named a file — is the easy half.
 */

const logger = createLogger({ level: 'silent', write: () => {} });
const USER = '11111111-1111-4111-8111-111111111111';

let dir: string;
let mock: MockProvider | undefined;
let store: ConversationStore;
let artifacts: ArtifactStore;
let service: GenerationService;

function providerFor(): LlamaCppProvider {
  return new LlamaCppProvider(
    {
      baseUrl: mock?.url as string,
      apiKey: undefined,
      timeoutMs: 5_000,
      defaultContextTokens: 8_192,
      maxOutputTokens: 4_096,
    },
    logger
  );
}

function hubFor(): ProviderHub {
  const hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 4_096,
    factory: () => providerFor(),
  });
  hub.setProviders([
    {
      id: 'local',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: mock?.url as string,
      timeoutMs: 5_000,
      capabilities: {},
    },
  ]);
  return hub;
}

async function boot(options: MockProviderOptions): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'artifact-capture-'));
  const paths = new StoragePaths(dir);

  mock = await startMockProvider({ chunkDelayMs: 1, ...options });
  const provider = providerFor();

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  artifacts = new ArtifactStore(paths, logger);

  service = new GenerationService({
    store,
    index,
    manager: new GenerationManager({ provider, logger, maxOutputTokens: 4_096 }),
    hub: hubFor(),
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 4_096,
    artifacts,
  });
}

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Runs one turn to its terminal state and returns the conversation id. */
async function ask(): Promise<string> {
  const { id } = await store.create(USER, 'Test');
  await service.start(USER, id, 'local', 'GPT', 'write me a file');
  await service.settled(USER, id);
  return id;
}

const fence = (info: string, body: string): string[] => [`\`\`\`${info}\n`, `${body}\n`, '```\n'];

describe('a completed reply that named a file', () => {
  it('saves it as an artifact with the contents of the block', async () => {
    await boot({
      contentChunks: ['Here it is.\n\n', ...fence('html file="page.html"', '<p>hi</p>')],
    });

    await ask();

    const saved = await artifacts.list(USER);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'page.html', mediaType: 'text/html' });
    expect(await artifacts.content(USER, saved[0]?.id as string)).toBe('<p>hi</p>');
  });

  it('links it to the conversation and the turn that produced it', async () => {
    await boot({ contentChunks: fence('file="notes.md"', '# Notes') });

    const conversationId = await ask();

    const conversation = await store.load(USER, conversationId);
    const assistant = conversation.messages.at(-1);
    expect(await artifacts.list(USER)).toMatchObject([
      { conversationId, messageId: assistant?.id },
    ]);
  });

  it('leaves the reply and its code block in the transcript', async () => {
    await boot({
      contentChunks: ['Here it is.\n\n', ...fence('css file="a.css"', 'p { color: red }')],
    });

    const conversationId = await ask();

    const body = (await store.load(USER, conversationId)).messages.at(-1)?.body ?? '';
    expect(body).toContain('Here it is.');
    expect(body).toContain('```css file="a.css"');
    expect(body).toContain('p { color: red }');
  });

  it.each(CAPTURED_EXTENSIONS)('saves a .%s file', async (extension) => {
    await boot({ contentChunks: fence(`file="report.${extension}"`, 'contents') });

    await ask();

    expect(await artifacts.list(USER)).toMatchObject([{ name: `report.${extension}` }]);
  });

  it('matches an uppercase extension and keeps the name as written', async () => {
    await boot({ contentChunks: fence('file="REPORT.MD"', '# Shouting') });

    await ask();

    expect(await artifacts.list(USER)).toMatchObject([
      { name: 'REPORT.MD', mediaType: 'text/markdown' },
    ]);
  });

  it('saves one artifact per file when a reply presents several', async () => {
    await boot({
      contentChunks: [
        'Two files:\n\n',
        ...fence('html file="page.html"', '<p>hi</p>'),
        '\nand\n\n',
        ...fence('css file="page.css"', 'p {}'),
      ],
    });

    await ask();

    const saved = await artifacts.list(USER);
    expect(saved.map((artifact) => artifact.name).sort()).toEqual(['page.css', 'page.html']);
  });

  it('flattens a path-like name rather than following it', async () => {
    await boot({ contentChunks: fence('file="../../etc/passwd.md"', 'nope') });

    await ask();

    const [saved] = await artifacts.list(USER);
    expect(saved?.name).not.toMatch(/[\\/]/);
    expect(saved?.name).toBe('..∕..∕etc∕passwd.md');
  });
});

describe('a reply that named nothing', () => {
  it('saves nothing for an ordinary code block', async () => {
    await boot({ contentChunks: ['Try this:\n\n', ...fence('html', '<p>hi</p>')] });

    await ask();

    expect(await artifacts.list(USER)).toEqual([]);
  });

  it('saves nothing for a filename mentioned in prose', async () => {
    await boot({
      contentChunks: ['Edit index.html and then styles.css, and run app.py when you are done.'],
    });

    await ask();

    expect(await artifacts.list(USER)).toEqual([]);
  });

  it('saves nothing for an extension it does not keep', async () => {
    await boot({ contentChunks: fence('file="notes.txt"', 'plain') });

    await ask();

    expect(await artifacts.list(USER)).toEqual([]);
  });
});

/*
 * Nothing is saved from a run the reader never saw finish. A cancelled or
 * failed reply can be halfway through a file, and half a document under the
 * name of a whole one is worse than nothing at all.
 */
describe('a run that did not complete', () => {
  it('saves nothing when it was cancelled', async () => {
    await boot({
      contentChunks: ['start\n', ...fence('file="half.md"', '# Half'), 'end'],
      chunkDelayMs: 40,
    });

    const { id } = await store.create(USER, 'Test');
    const { generationId } = await service.start(USER, id, 'local', 'GPT', 'write a file');
    await service.cancel(USER, id, generationId);
    await service.settled(USER, id);

    expect(await artifacts.list(USER)).toEqual([]);
  });

  it('saves nothing when the provider failed', async () => {
    await boot({ failWith: { status: 500, message: 'upstream exploded' } });

    const conversationId = await ask();

    expect((await store.load(USER, conversationId)).messages.at(-1)).toMatchObject({
      status: 'failed',
    });
    expect(await artifacts.list(USER)).toEqual([]);
  });

  it('saves nothing from an unclosed block, however the run ended', async () => {
    await boot({ contentChunks: ['```html file="cut.html"\n', '<!doctype html>\n'] });

    await ask();

    expect(await artifacts.list(USER)).toEqual([]);
  });
});

/*
 * The idempotency the requirement is really about: a stream that reconnects, a
 * page that reloads, a completion handled twice, or a recovery pass all end up
 * asking the store to save the same file for the same turn.
 */
describe('a completion seen more than once', () => {
  it('creates no second copy', async () => {
    await boot({ contentChunks: fence('file="page.html"', '<p>hi</p>') });

    const conversationId = await ask();
    const assistantId = (await store.load(USER, conversationId)).messages.at(-1)?.id as string;

    // The same capture again, as a re-processed completion event would do it.
    const before = await artifacts.list(USER);
    expect(await artifacts.presentedAlready(USER, conversationId, assistantId, 'page.html')).toBe(
      true
    );
    expect(await artifacts.list(USER)).toEqual(before);
  });

  it('does not block the same filename from a later turn', async () => {
    await boot({ contentChunks: fence('file="page.html"', '<p>hi</p>') });

    await ask();
    // A second conversation presenting the same name is a different file.
    await ask();

    expect(await artifacts.list(USER)).toHaveLength(2);
  });
});

/* The store's absence is what turns the capture off, so a server that has not
   opted in behaves exactly as it did before any of this existed. */
describe('with no artifact store configured', () => {
  it('saves nothing', async () => {
    await boot({ contentChunks: fence('file="page.html"', '<p>hi</p>') });
    const withoutArtifacts = new GenerationService({
      store,
      index: new ChatIndex({ store, logger }),
      manager: new GenerationManager({ provider: providerFor(), logger, maxOutputTokens: 4_096 }),
      hub: hubFor(),
      logger,
      defaultContextTokens: 8_192,
      maxOutputTokens: 4_096,
    });

    const { id } = await store.create(USER, 'Test');
    await withoutArtifacts.start(USER, id, 'local', 'GPT', 'write me a file');
    await withoutArtifacts.settled(USER, id);

    expect(await artifacts.list(USER)).toEqual([]);
  });
});
