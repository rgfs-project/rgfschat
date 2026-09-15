import { readdir, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { atomicWriteFile, ensureDir } from './atomic.ts';
import { KeyedLock } from './locks.ts';
import { isMemoryName, type StoragePaths } from './paths.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';

/**
 * What a reader wants remembered, as Markdown on disk.
 *
 * `data/<user>/memories/<name>.md`, one note per file, in the same spirit as
 * the conversations beside them: text a person can read, edit, back up and
 * delete with the tools they already have, rather than rows in a database this
 * application owns.
 *
 * Memories are prepended to the system prompt of every generation, which is
 * what makes the size cap a correctness concern rather than tidiness: the
 * context they take is context the conversation cannot use. Both limits are
 * enforced on write, so a reader is told *now* rather than discovering it as a
 * truncated prompt later.
 */

export const MEMORY_MAX_BYTES = 8 * 1024;
export const MEMORIES_MAX_TOTAL_BYTES = 32 * 1024;

export interface Memory {
  name: string;
  content: string;
  updatedAt: string;
  bytes: number;
}

/**
 * Which note a write is allowed to land on.
 *
 * `upsert` is the historical behaviour and stays the default, because the
 * routes a person drives — the memories panel, an import — mean "make it say
 * this" and have the note in front of them. A *proposal* does not: it was made
 * turns ago, out of a conversation, by something that cannot see the disk. So
 * an accepted `remember` is `create` and an accepted `update_memory` is
 * `update`, and the difference is the whole of issue 2: with `upsert` a model
 * that proposed a new note under a name that already existed would silently
 * replace it.
 */
export type WriteMode = 'create' | 'update' | 'upsert';

/** Lock key for one note, so check-then-write cannot interleave with itself. */
function memoryKey(userId: string, name: string): string {
  return `memory:${userId}/${name}`;
}

export class MemoryStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #locks: KeyedLock;

  constructor(paths: StoragePaths, logger: Logger, locks: KeyedLock = new KeyedLock()) {
    this.#paths = paths;
    this.#logger = logger;
    this.#locks = locks;
  }

  /** Every memory, oldest name first. A missing directory means none. */
  async list(userId: string): Promise<Memory[]> {
    const dir = this.#paths.memoriesDir(userId);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    const memories: Memory[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3);
      // A file someone dropped in by hand under a name this application would
      // never write is left alone rather than served back under a name the API
      // cannot address.
      if (!isMemoryName(name)) continue;

      const memory = await this.read(userId, name);
      if (memory !== null) memories.push(memory);
    }

    return memories.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(userId: string, name: string): Promise<Memory | null> {
    if (!isMemoryName(name)) return null;

    try {
      const file = this.#paths.memoryFile(userId, name);
      const content = await readFile(file, 'utf8');
      const { mtime } = await stat(file);
      return { name, content, updatedAt: mtime.toISOString(), bytes: Buffer.byteLength(content) };
    } catch {
      return null;
    }
  }

  /**
   * Writes one memory, replacing any note of that name.
   *
   * The total is checked against what the store would hold *after* this write,
   * so the last memory that fits is accepted and the one that would not is
   * refused — rather than the store silently exceeding its cap by one note.
   *
   * `mode` and `expectedUpdatedAt` are what an accepted proposal adds. Both
   * refusals are `CONFLICT` rather than `VALIDATION`: nothing is wrong with
   * the request, the note on disk is simply not the one the proposal was made
   * about. The whole check-then-write runs under this note's lock, so two
   * accepts of the same name cannot both find it absent and both "create" it.
   */
  async write(
    userId: string,
    name: string,
    content: string,
    options: {
      /**
       * When this note was last changed, if that is known to be something
       * other than now.
       *
       * An import carries the time the memory was actually written, and a list
       * that stamps every imported note with the minute of the import loses
       * the only ordering it had. Applied to the file's mtime because that is
       * where `updatedAt` is read from — one source of truth, so a memory
       * edited by hand outside this application still reports honestly.
       */
      modifiedAt?: string | undefined;
      /** Default `upsert`, which is what every person-driven route wants. */
      mode?: WriteMode | undefined;
      /**
       * The `updatedAt` the caller last saw, for an `update`.
       *
       * A proposal is made at one moment and accepted at another, and in
       * between the reader may have edited or replaced the note themselves. A
       * blind write would throw that away without anyone being told, so the
       * baseline is carried on the proposal and compared here.
       */
      expectedUpdatedAt?: string | undefined;
    } = {}
  ): Promise<Memory> {
    if (!isMemoryName(name)) {
      throw AppError.validation(
        'A memory name is lowercase letters, digits and hyphens, up to 64 characters.'
      );
    }

    const bytes = Buffer.byteLength(content);
    if (content.trim() === '') throw AppError.validation('A memory cannot be empty.');
    if (bytes > MEMORY_MAX_BYTES) {
      throw AppError.validation(`A memory is at most ${MEMORY_MAX_BYTES / 1024}KB.`);
    }

    const mode = options.mode ?? 'upsert';

    return this.#locks.run(memoryKey(userId, name), async () => {
      const current = await this.read(userId, name);

      if (mode === 'create' && current !== null) {
        throw new AppError(
          'CONFLICT',
          `A memory called "${name}" already exists, so it was not replaced.`
        );
      }
      if (mode === 'update') {
        if (current === null) {
          throw new AppError('CONFLICT', `There is no memory called "${name}" any more.`);
        }
        this.#requireFresh(name, current, options.expectedUpdatedAt);
      }

      const existing = await this.list(userId);
      const total =
        existing.reduce((sum, memory) => sum + (memory.name === name ? 0 : memory.bytes), 0) +
        bytes;
      if (total > MEMORIES_MAX_TOTAL_BYTES) {
        throw AppError.validation(
          `Memories are at most ${MEMORIES_MAX_TOTAL_BYTES / 1024}KB in total; this would be ${Math.ceil(total / 1024)}KB.`
        );
      }

      await ensureDir(this.#paths.memoriesDir(userId));
      const file = this.#paths.memoryFile(userId, name);
      await atomicWriteFile(file, content);

      if (options.modifiedAt !== undefined) {
        const at = new Date(options.modifiedAt);
        // An unparseable timestamp leaves the write alone rather than failing it:
        // the note is worth more than its date.
        if (!Number.isNaN(at.getTime())) await utimes(file, at, at).catch(() => undefined);
      }

      this.#logger.info('Memory written', { userId, name, bytes });

      return (await this.read(userId, name)) ?? { name, content, updatedAt: '', bytes };
    });
  }

  /**
   * Refuses a write aimed at a version of the note that is no longer there.
   *
   * An absent baseline is not treated as "anything goes": a caller that asks
   * for the staleness check gets it, and a caller that does not want it does
   * not pass `update`.
   */
  #requireFresh(name: string, current: Memory, expectedUpdatedAt: string | undefined): void {
    if (expectedUpdatedAt === undefined) return;
    if (expectedUpdatedAt === current.updatedAt) return;

    throw new AppError(
      'CONFLICT',
      `The memory "${name}" has changed since this was proposed, so it was not overwritten.`
    );
  }

  /** Removes one. Resolves to whether there was anything to remove. */
  async remove(userId: string, name: string): Promise<boolean> {
    if (!isMemoryName(name)) return false;
    try {
      await unlink(this.#paths.memoryFile(userId, name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes one on behalf of a proposal, refusing a stale one.
   *
   * Deleting the wrong note is the worst outcome in this file — the content is
   * gone and there is nothing to compare afterwards — so a deletion the reader
   * has since edited past is a `CONFLICT` they are shown, not a silent
   * unlink. Under the note's lock, like `write`, so it cannot race an accept
   * of a write proposal for the same name.
   */
  async removeIfUnchanged(
    userId: string,
    name: string,
    expectedUpdatedAt: string | undefined
  ): Promise<boolean> {
    if (!isMemoryName(name)) return false;

    return this.#locks.run(memoryKey(userId, name), async () => {
      const current = await this.read(userId, name);
      // Already gone is the outcome the proposal asked for, so it is not a
      // conflict — there is nothing left to lose by agreeing.
      if (current === null) return false;

      this.#requireFresh(name, current, expectedUpdatedAt);

      return this.remove(userId, name);
    });
  }

  /**
   * The memories as one block for the system prompt, or `null` when there is
   * nothing to say. Named and fenced so the model can tell remembered context
   * from the instruction around it, and from the conversation itself.
   *
   * With `tools` set the block is produced even when there are no memories yet:
   * a model that is told it can propose one needs to be told so on the first
   * conversation too, which is exactly when the list is empty.
   */
  async prompt(userId: string, options: { tools?: boolean } = {}): Promise<string | null> {
    const memories = await this.list(userId);
    if (memories.length === 0 && options.tools !== true) return null;

    const sections: string[] = [];

    if (memories.length > 0) {
      const blocks = memories.map((memory) => `## ${memory.name}\n\n${memory.content.trim()}`);
      sections.push(
        `The following notes are what this user has asked you to remember.\n\n${blocks.join('\n\n')}`
      );
    } else {
      sections.push('You have no saved notes about this user yet.');
    }

    if (options.tools === true) {
      /*
       * Two things the model cannot work out from the schemas alone, and both
       * are failure modes seen in practice: it will claim to have saved
       * something the reader never agreed to, and it will propose a note after
       * every passing remark. Naming the existing notes as the only valid
       * targets for update and delete is the third — the tool descriptions say
       * so, but the list they refer to is here.
       */
      sections.push(
        'You can propose changes to these notes with the memory tools. A proposal is ' +
          'shown to the user and takes effect only if they accept it, so never say a note ' +
          'has been saved, changed or deleted — say that you have offered to. Propose ' +
          'something only when it is a durable fact or preference worth recalling in a ' +
          'later conversation, or when the user asks you to remember, update or forget ' +
          'something. Only the note names listed above may be updated or deleted.'
      );
    }

    return sections.join('\n\n');
  }
}
