import { readFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { atomicWriteFile } from './atomic.ts';
import type { ConversationStore } from './conversations.ts';
import { KeyedLock, chatsIndexKey } from './locks.ts';

/**
 * The derived conversation index (`data/<user>/index/chats.json`).
 *
 * This file is a cache, never a source of truth (INV-11). Deleting it loses
 * nothing: it is rebuilt from the canonical Markdown on the next startup or on
 * demand. Anything that cannot be answered from the Markdown does not belong
 * here.
 *
 * Writes go through a process-wide queue keyed per user and land atomically, so
 * a reader never sees a half-written index and two concurrent mutations cannot
 * interleave into a lost update.
 */

export interface ChatIndexEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** A file that exists but cannot be parsed. Still listed (contracts §3.7). */
  malformed: boolean;
}

interface ChatIndexFile {
  version: 1;
  /**
   * Set before a mutation and cleared after it succeeds. A file still marked
   * dirty at startup means the process died mid-update, so it is rebuilt rather
   * than trusted.
   */
  dirty: boolean;
  entries: ChatIndexEntry[];
}

const entrySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().min(0),
  malformed: z.boolean(),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  dirty: z.boolean(),
  entries: z.array(entrySchema),
});

/** Title shown for a file that cannot be parsed. Never written to Markdown. */
const MALFORMED_TITLE = '(unreadable conversation)';

export class ChatIndex {
  readonly #store: ConversationStore;
  readonly #logger: Logger;
  readonly #queue: KeyedLock;

  constructor(options: { store: ConversationStore; logger: Logger; queue?: KeyedLock }) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#queue = options.queue ?? new KeyedLock();
  }

  #file(userId: string): string {
    return this.#store.paths.chatsIndexFile(userId);
  }

  /** Reads the index, or `null` when missing, unparseable, or dirty. */
  async #readValid(userId: string): Promise<ChatIndexEntry[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.#file(userId), 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#logger.warn('Chat index is not valid JSON; rebuilding', { userId });
      return null;
    }

    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      this.#logger.warn('Chat index has an unexpected shape; rebuilding', { userId });
      return null;
    }
    if (result.data.dirty) {
      this.#logger.warn('Chat index was left dirty; rebuilding', { userId });
      return null;
    }

    return result.data.entries;
  }

  async #write(userId: string, entries: ChatIndexEntry[], dirty = false): Promise<void> {
    const file: ChatIndexFile = { version: 1, dirty, entries };
    await atomicWriteFile(this.#file(userId), `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * Rebuilds from canonical Markdown by scanning `chats/`.
   *
   * A file that fails to parse is listed with `malformed: true` rather than
   * skipped, so a corrupt conversation stays visible and deletable instead of
   * silently vanishing from the UI.
   */
  async rebuild(userId: string): Promise<ChatIndexEntry[]> {
    return this.#queue.run(chatsIndexKey(userId), async () => {
      const entries = await this.#scan(userId);
      await this.#write(userId, entries);
      this.#logger.info('Rebuilt chat index', { userId, count: entries.length });
      return entries;
    });
  }

  async #scan(userId: string): Promise<ChatIndexEntry[]> {
    const ids = await this.#store.listIds(userId);
    const entries: ChatIndexEntry[] = [];

    for (const id of ids) {
      const inspected = await this.#store.inspect(userId, id);
      if (inspected.ok) {
        const { title, createdAt, updatedAt, messages } = inspected.conversation;
        entries.push({
          id,
          title,
          createdAt,
          updatedAt,
          messageCount: messages.length,
          malformed: false,
        });
      } else {
        entries.push({
          id,
          title: MALFORMED_TITLE,
          createdAt: '1970-01-01T00:00:00.000Z',
          updatedAt: '1970-01-01T00:00:00.000Z',
          messageCount: 0,
          malformed: true,
        });
      }
    }

    return sortEntries(entries);
  }

  /** Returns the index, rebuilding transparently when it is missing or unusable. */
  async list(userId: string): Promise<ChatIndexEntry[]> {
    const existing = await this.#readValid(userId);
    if (existing !== null) return existing;
    return this.rebuild(userId);
  }

  /**
   * Applies a change to a single entry under the per-user queue.
   *
   * The dirty marker is set before the change and cleared with it, so a crash
   * between the two leaves a file that startup knows not to trust.
   */
  async #mutate(
    userId: string,
    change: (entries: ChatIndexEntry[]) => ChatIndexEntry[]
  ): Promise<void> {
    await this.#queue.run(chatsIndexKey(userId), async () => {
      const current = (await this.#readValid(userId)) ?? (await this.#scan(userId));

      await this.#write(userId, current, true);
      const next = sortEntries(change(current));
      await this.#write(userId, next, false);
    });
  }

  async upsert(userId: string, entry: ChatIndexEntry): Promise<void> {
    await this.#mutate(userId, (entries) => [
      ...entries.filter((candidate) => candidate.id !== entry.id),
      entry,
    ]);
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    await this.#mutate(userId, (entries) =>
      entries.filter((candidate) => candidate.id !== conversationId)
    );
  }

  /** Deletes the index file. Used by tests and by `index:rebuild`. */
  async destroy(userId: string): Promise<void> {
    await unlink(this.#file(userId)).catch(() => undefined);
  }
}

/** Most recently updated first — the order the UI wants and the index caches. */
function sortEntries(entries: ChatIndexEntry[]): ChatIndexEntry[] {
  return [...entries].sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    return byUpdated !== 0 ? byUpdated : a.id.localeCompare(b.id);
  });
}

export function entryFor(
  id: string,
  conversation: { title: string; createdAt: string; updatedAt: string; messages: unknown[] }
): ChatIndexEntry {
  return {
    id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    malformed: false,
  };
}
