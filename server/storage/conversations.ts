import { randomUUID } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { DEFAULT_TITLE, type Conversation, type Message } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import { atomicWriteFile, cleanupTempFiles, ensureDir, pathExists } from './atomic.ts';
import { KeyedLock, conversationKey } from './locks.ts';
import { parseConversation, serializeConversation } from './markdown.ts';
import { StoragePaths } from './paths.ts';

/**
 * Canonical conversation storage.
 *
 * Markdown under `data/<user>/chats/` is the source of truth. Every mutation
 * runs under the conversation lock and lands through an atomic durable write,
 * and `updatedAt` is owned here — a client-supplied value is never honoured
 * (contracts §3.3).
 *
 * A malformed file is never repaired, normalised, or rewritten (INV-10): it is
 * readable only as an error, mutations refuse, and deletion is allowed.
 */
export class ConversationStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #locks: KeyedLock;
  readonly #now: () => Date;

  constructor(options: {
    paths: StoragePaths;
    logger: Logger;
    locks?: KeyedLock;
    now?: () => Date;
  }) {
    this.#paths = options.paths;
    this.#logger = options.logger;
    this.#locks = options.locks ?? new KeyedLock();
    this.#now = options.now ?? (() => new Date());
  }

  get locks(): KeyedLock {
    return this.#locks;
  }

  get paths(): StoragePaths {
    return this.#paths;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  /**
   * Prepares the user's directories and sweeps temp files left by a crash.
   * Also logs — never removes — unrecognised top-level entries (contracts §1).
   */
  async init(userId: string): Promise<void> {
    await ensureDir(this.#paths.chatsDir(userId));
    await ensureDir(this.#paths.indexDir(userId));

    const start = this.#now();
    await cleanupTempFiles(this.#paths.chatsDir(userId), start, this.#logger);
    await cleanupTempFiles(this.#paths.indexDir(userId), start, this.#logger);

    try {
      for (const entry of await readdir(this.#paths.root)) {
        if (!StoragePaths.isKnownTopLevelEntry(entry)) {
          this.#logger.warn('Ignoring unrecognised entry under DATA_DIR', { entry });
        }
      }
    } catch {
      // Root not readable yet; nothing to report.
    }
  }

  /** Reads and parses. Throws `CONVERSATION_MALFORMED` for a corrupt file. */
  async load(userId: string, conversationId: string): Promise<Conversation> {
    const raw = await this.#read(userId, conversationId);
    const parsed = parseConversation(raw);

    if (!parsed.ok) {
      this.#logger.warn('Conversation is malformed', {
        conversationId,
        reason: parsed.reason,
        line: parsed.line,
      });
      throw new AppError('CONVERSATION_MALFORMED', 'This conversation file cannot be read.');
    }

    return parsed.conversation;
  }

  /**
   * Writes a conversation that came from somewhere else.
   *
   * Serialized and then read back through the parser before it counts as
   * written: an import that leaves behind a file the server would call
   * malformed has not imported anything, and finding that out at write time is
   * the difference between a failed import and a broken conversation.
   */
  async writeImported(
    userId: string,
    conversationId: string,
    conversation: Conversation
  ): Promise<void> {
    await ensureDir(this.#paths.chatsDir(userId));
    await atomicWriteFile(
      this.#paths.conversationFile(userId, conversationId),
      serializeConversation(conversation)
    );
    await this.load(userId, conversationId);
  }

  /**
   * The stored file, unparsed.
   *
   * For export: what leaves the server is then byte-for-byte what is on disk,
   * rather than a re-serialization that could differ from it.
   */
  async raw(userId: string, conversationId: string): Promise<string> {
    return this.#read(userId, conversationId);
  }

  async #read(userId: string, conversationId: string): Promise<string> {
    const file = this.#paths.conversationFile(userId, conversationId);
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw AppError.notFound('Conversation not found.');
      }
      // A filesystem failure is a different class from a malformed file (§3.7).
      this.#logger.error('Failed to read conversation', { conversationId, error: err });
      throw AppError.internal('Could not read the conversation.');
    }
  }

  /** Parses without throwing, for the index scan where malformed is a value. */
  async inspect(
    userId: string,
    conversationId: string
  ): Promise<{ ok: true; conversation: Conversation } | { ok: false }> {
    try {
      const parsed = parseConversation(await this.#read(userId, conversationId));
      return parsed.ok ? { ok: true, conversation: parsed.conversation } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Creates an empty conversation. The id is the filename, not a document
   * field — the Markdown never stores its own id, so a file can be copied or
   * renamed without becoming self-contradictory.
   */
  async create(
    userId: string,
    title: string = DEFAULT_TITLE
  ): Promise<{ id: string; conversation: Conversation }> {
    const id = randomUUID();
    const now = this.#timestamp();
    const conversation: Conversation = {
      formatVersion: 1,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    await this.#locks.run(conversationKey(userId, id), async () => {
      await atomicWriteFile(
        this.#paths.conversationFile(userId, id),
        serializeConversation(conversation)
      );
    });

    return { id, conversation };
  }

  /**
   * Read-modify-write under the conversation lock.
   *
   * `mutate` receives the parsed conversation and returns the next one;
   * `updatedAt` is stamped here so storage owns it, and `createdAt` is carried
   * through unchanged because it is immutable after creation (contracts §3.3).
   */
  async update(
    userId: string,
    conversationId: string,
    mutate: (current: Conversation) => Conversation | Promise<Conversation>
  ): Promise<Conversation> {
    return this.#locks.run(conversationKey(userId, conversationId), async () => {
      const current = await this.load(userId, conversationId);
      const next = await mutate(current);

      const written: Conversation = {
        ...next,
        createdAt: current.createdAt,
        updatedAt: this.#timestamp(),
      };

      await atomicWriteFile(
        this.#paths.conversationFile(userId, conversationId),
        serializeConversation(written)
      );
      return written;
    });
  }

  /**
   * Writes a conversation **without** taking the lock.
   *
   * Only for callers already running inside `locks.run(conversationKey(...))` —
   * taking it again would deadlock. `updatedAt` is still stamped here and
   * `createdAt` is still carried through, so storage keeps ownership of both
   * regardless of which entry point is used.
   */
  async writeUnderLock(
    userId: string,
    conversationId: string,
    next: Conversation
  ): Promise<Conversation> {
    const written: Conversation = { ...next, updatedAt: this.#timestamp() };

    await atomicWriteFile(
      this.#paths.conversationFile(userId, conversationId),
      serializeConversation(written)
    );
    return written;
  }

  /** Appends messages atomically. The whole read-append-write holds the lock. */
  async appendMessages(
    userId: string,
    conversationId: string,
    messages: Message[]
  ): Promise<Conversation> {
    return this.update(userId, conversationId, (current) => ({
      ...current,
      messages: [...current.messages, ...messages],
    }));
  }

  /**
   * Replaces one message's body under the lock.
   *
   * Editing is confined to the body: ids, types, and an assistant block's
   * status/provider/model are records of what happened and are not rewritten.
   */
  async editMessageBody(
    userId: string,
    conversationId: string,
    messageId: string,
    body: string
  ): Promise<Conversation> {
    return this.update(userId, conversationId, (current) => {
      if (!current.messages.some((message) => message.id === messageId)) {
        throw AppError.notFound('Message not found.');
      }
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId ? { ...message, body } : message
        ),
      };
    });
  }

  /**
   * Removes a message and its paired reply, under the lock.
   *
   * A user message and the assistant message answering it are one exchange, so
   * deleting the question takes its answer with it — an orphaned reply would
   * read as the assistant volunteering something unprompted. Later turns are
   * kept: the history gains a gap, but nothing the user did not click on is
   * discarded.
   *
   * Deleting an assistant message removes only that message, leaving the
   * question in place so it can be regenerated or answered again.
   *
   * An assistant block's reasoning travels with it automatically, because
   * reasoning is a field on that message rather than a separate one.
   */
  async deleteMessagePair(
    userId: string,
    conversationId: string,
    messageId: string
  ): Promise<Conversation> {
    return this.update(userId, conversationId, (current) => {
      const at = current.messages.findIndex((message) => message.id === messageId);
      if (at === -1) throw AppError.notFound('Message not found.');

      const target = current.messages[at];
      const next = current.messages[at + 1];
      // Only a user message drags a reply with it, and only the one directly
      // after it — a following `user` message is a separate exchange.
      const removeCount = target?.type === 'user' && next?.type === 'assistant' ? 2 : 1;

      return {
        ...current,
        messages: [...current.messages.slice(0, at), ...current.messages.slice(at + removeCount)],
      };
    });
  }

  /**
   * Deletes the canonical Markdown under the lock. Allowed even when the file
   * is malformed (INV-10). The caller removes the index entry afterwards:
   * Markdown first, so an orphaned index entry is the failure mode rather than
   * a dangling reference to a file that still exists.
   */
  async delete(userId: string, conversationId: string): Promise<void> {
    await this.#locks.run(conversationKey(userId, conversationId), async () => {
      const file = this.#paths.conversationFile(userId, conversationId);
      try {
        await unlink(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw AppError.notFound('Conversation not found.');
        }
        throw err;
      }
    });
  }

  async exists(userId: string, conversationId: string): Promise<boolean> {
    return pathExists(this.#paths.conversationFile(userId, conversationId));
  }

  /** Every conversation id present on disk, from the filenames themselves. */
  async listIds(userId: string): Promise<string[]> {
    const dir = this.#paths.chatsDir(userId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const ids: string[] = [];
    for (const entry of entries) {
      const id = StoragePaths.conversationIdFromFilename(entry);
      if (id !== null) ids.push(id);
    }
    return ids.sort();
  }
}
