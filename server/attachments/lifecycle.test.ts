import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';
import { pngBytes } from './testImages.ts';
import { AttachmentStore } from './store.ts';
import { reconcileAttachments } from './reconcile.ts';
import { referencedIds, resolveAttachments } from './resolve.ts';

/**
 * The lifecycle across storage boundaries: Markdown, attachments, and the
 * recovery that reconnects them after a crash.
 */

const USER = '33333333-3333-4333-8333-333333333333';
const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let paths: StoragePaths;
let store: ConversationStore;
let index: ChatIndex;
let attachments: AttachmentStore;

// eslint-disable-next-line @typescript-eslint/require-await -- stands in for a request stream
async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const utf8 = (content: string): Uint8Array => new Uint8Array(Buffer.from(content, 'utf8'));
const PNG = pngBytes();

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'attachment-lifecycle-'));
  paths = new StoragePaths(dataDir);
  store = new ConversationStore({ paths, logger });
  index = new ChatIndex({ store, logger });
  attachments = new AttachmentStore(paths, {
    maxBytes: 1_000_000,
    maxTotalBytesPerUser: 10_000_000,
    pendingTtlMs: 60_000,
    maxImagePixels: 50_000_000,
  });
  await attachments.ensureUserDir(USER);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Writes a conversation whose single user message carries `ids`. */
async function conversationWith(ids: string[]): Promise<{ id: string; messageId: string }> {
  const messageId = randomUUID();
  const { id } = await store.create(USER, 'With attachments');

  await store.update(USER, id, (current) => ({
    ...current,
    messages: [
      {
        type: 'user' as const,
        id: messageId,
        body: 'Look at this',
        ...(ids.length === 0 ? {} : { attachments: ids }),
      },
    ],
  }));

  await index.rebuild(USER);
  return { id, messageId };
}

describe('the Markdown is the link', () => {
  it('round-trips the attachments attribute', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    const { id } = await conversationWith([meta.id]);

    // Read back off disk, through the parser, not from memory.
    const reloaded = await store.load(USER, id);
    expect(referencedIds(reloaded)).toEqual([meta.id]);

    const raw = await readFile(paths.conversationFile(USER, id), 'utf8');
    expect(raw).toContain(`attachments="${meta.id}"`);
  });
});

describe('reconciliation after a crash', () => {
  it('links attachments a message already refers to', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));

    // Exactly the crash window: the Markdown names it, the attachment is still
    // pending because the process died before linking.
    const { id, messageId } = await conversationWith([meta.id]);
    expect((await attachments.read(USER, meta.id)).messageId).toBeNull();

    const result = await reconcileAttachments({ attachments, store, index, userId: USER, logger });

    expect(result).toEqual({ linked: 1 });
    expect(await attachments.read(USER, meta.id)).toMatchObject({
      conversationId: id,
      messageId,
    });
  });

  it('is safe to run twice', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    await conversationWith([meta.id]);

    await reconcileAttachments({ attachments, store, index, userId: USER, logger });
    const second = await reconcileAttachments({ attachments, store, index, userId: USER, logger });

    // Already linked, so there is nothing left to adopt.
    expect(second).toEqual({ linked: 0 });
  });

  it('survives a reference to an attachment that no longer exists', async () => {
    await conversationWith([randomUUID()]);

    const result = await reconcileAttachments({ attachments, store, index, userId: USER, logger });

    expect(result).toEqual({ linked: 0 });
  });

  it('deletes nothing', async () => {
    // A pending attachment nobody references is the sweep's business, not this
    // scan's — conflating the two would let a bug here destroy files.
    const { meta } = await attachments.create(USER, 'orphan.txt', once(utf8('x')));

    await reconcileAttachments({ attachments, store, index, userId: USER, logger });

    expect((await attachments.read(USER, meta.id)).id).toBe(meta.id);
  });
});

describe('resolving for a prompt', () => {
  it('inlines text and truncates it at the limit, without touching what is stored', async () => {
    const body = 'x'.repeat(500);
    const { meta } = await attachments.create(USER, 'log.txt', once(utf8(body)));
    const { id } = await conversationWith([meta.id]);
    const conversation = await store.load(USER, id);

    const resolved = await resolveAttachments(attachments, USER, conversation, {
      maxInlineChars: 100,
      modalities: ['text', 'image', 'audio'],
    });

    expect(resolved.get(meta.id)).toMatchObject({ kind: 'text', truncated: true });
    expect(resolved.get(meta.id)?.content).toHaveLength(100);
    // The stored file is unchanged; truncation exists only for the prompt.
    expect((await attachments.bytes(USER, meta.id)).toString('utf8')).toHaveLength(500);
  });

  it('encodes an image as a data URL, never a remote one', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    const { id } = await conversationWith([meta.id]);
    const conversation = await store.load(USER, id);

    const resolved = await resolveAttachments(attachments, USER, conversation, {
      maxInlineChars: 100,
      modalities: ['text', 'image', 'audio'],
    });

    expect(resolved.get(meta.id)?.content).toMatch(/^data:image\/png;base64,/);
  });

  it('skips images entirely for a model that cannot see', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    const { id } = await conversationWith([meta.id]);
    const conversation = await store.load(USER, id);

    const resolved = await resolveAttachments(attachments, USER, conversation, {
      maxInlineChars: 100,
      modalities: ['text'],
    });

    // Not merely excluded from the prompt — never read from disk at all.
    expect(resolved.size).toBe(0);
  });

  it('skips an attachment that has been deleted, rather than failing', async () => {
    const { meta } = await attachments.create(USER, 'photo.png', once(PNG));
    const { id } = await conversationWith([meta.id]);
    await rm(paths.attachmentDir(USER, meta.id), { recursive: true, force: true });

    const conversation = await store.load(USER, id);
    const resolved = await resolveAttachments(attachments, USER, conversation, {
      maxInlineChars: 100,
      modalities: ['text', 'image', 'audio'],
    });

    // A conversation that can never be continued again because a file was
    // removed would be worse than one that continues without it (contracts §7).
    expect(resolved.size).toBe(0);
  });
});

describe('a conversation owns the attachments it names', () => {
  it('deleting it releases them, and only its own', async () => {
    const mine = await attachments.create(USER, 'mine.png', once(PNG));
    const other = await attachments.create(USER, 'other.png', once(PNG));

    const { id, messageId } = await conversationWith([mine.meta.id]);
    await attachments.link(USER, [mine.meta.id], id, messageId);

    // What the route does, in the order it does it: read the references,
    // delete the Markdown, then release the files.
    const owned = referencedIds(await store.load(USER, id));
    await store.delete(USER, id);
    await attachments.deleteMany(USER, owned);

    await expect(attachments.read(USER, mine.meta.id)).rejects.toThrow();
    // An attachment belonging to no conversation is untouched by this.
    expect((await attachments.read(USER, other.meta.id)).id).toBe(other.meta.id);
  });

  it('a malformed conversation is still deletable, leaving orphans behind', async () => {
    const { meta } = await attachments.create(USER, 'orphan.png', once(PNG));
    const { id, messageId } = await conversationWith([meta.id]);
    await attachments.link(USER, [meta.id], id, messageId);

    // Corrupted by hand, exactly as INV-10 contemplates.
    await writeFile(paths.conversationFile(USER, id), 'not a conversation at all', 'utf8');

    /*
     * The references cannot be read, so nothing is released — and that is the
     * intended outcome. An orphan is collectable; refusing to delete a
     * conversation because its file is unreadable is not.
     */
    const owned = await (async () => {
      try {
        return referencedIds(await store.load(USER, id));
      } catch {
        return [];
      }
    })();
    expect(owned).toEqual([]);

    await expect(store.delete(USER, id)).resolves.toBeUndefined();
    expect((await attachments.read(USER, meta.id)).id).toBe(meta.id);
  });
});
