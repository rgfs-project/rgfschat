import { readdir, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { atomicWriteFile, ensureDir } from './atomic.ts';
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

export class MemoryStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;

  constructor(paths: StoragePaths, logger: Logger) {
    this.#paths = paths;
    this.#logger = logger;
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

    const existing = await this.list(userId);
    const total =
      existing.reduce((sum, memory) => sum + (memory.name === name ? 0 : memory.bytes), 0) + bytes;
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
   * The memories as one block for the system prompt, or `null` when there are
   * none. Named and fenced so the model can tell remembered context from the
   * instruction around it, and from the conversation itself.
   */
  async prompt(userId: string): Promise<string | null> {
    const memories = await this.list(userId);
    if (memories.length === 0) return null;

    const blocks = memories.map((memory) => `## ${memory.name}\n\n${memory.content.trim()}`);
    return `The following notes are what this user has asked you to remember.\n\n${blocks.join('\n\n')}`;
  }
}
