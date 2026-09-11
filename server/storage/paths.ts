import { isAbsolute, resolve, sep } from 'node:path';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';

/**
 * The one and only place a filesystem path is constructed (contracts §1).
 *
 * Two rules make INV-12 hold:
 *   1. Every segment is *validated*, never merely escaped. A user id or
 *      conversation id must be a canonical lowercase UUID, and filenames come
 *      from a fixed set. A request-controlled string is never concatenated in.
 *   2. Every resolved path is asserted to remain inside `DATA_DIR` before it is
 *      returned, so even a bug in rule 1 cannot produce a path that escapes.
 *
 * Nothing outside this module may join paths under `DATA_DIR`.
 */

/** Reserved top-level directory for process-owned state. Never a valid user id. */
export const SYSTEM_DIR = '_system';

export class StoragePaths {
  readonly #root: string;

  constructor(dataDir: string) {
    if (!isAbsolute(dataDir)) {
      throw new Error('DATA_DIR must be an absolute path');
    }
    this.#root = resolve(dataDir);
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Final guard: the resolved path must be the root itself or sit beneath it.
   * Comparing with a trailing separator prevents `/data-evil` matching `/data`.
   */
  #contain(candidate: string): string {
    const resolved = resolve(candidate);
    if (resolved !== this.#root && !resolved.startsWith(this.#root + sep)) {
      throw AppError.internal('Resolved path escapes the data directory');
    }
    return resolved;
  }

  /**
   * Validates an id used as a path segment. Rejects traversal, separators, NUL,
   * and anything that is not a canonical lowercase UUID — before any syscall.
   */
  #segment(id: string, label: string): string {
    if (typeof id !== 'string' || !isCanonicalUuid(id)) {
      throw AppError.internal(`Invalid ${label} for path construction`);
    }
    return id;
  }

  userDir(userId: string): string {
    return this.#contain(resolve(this.#root, this.#segment(userId, 'user id')));
  }

  chatsDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'chats'));
  }

  /** `data/<user>/chats/<conversation>.md` — the canonical conversation file. */
  conversationFile(userId: string, conversationId: string): string {
    const name = `${this.#segment(conversationId, 'conversation id')}.md`;
    return this.#contain(resolve(this.chatsDir(userId), name));
  }

  indexDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'index'));
  }

  /** `data/<user>/index/chats.json` — derived, deletable, rebuildable. */
  chatsIndexFile(userId: string): string {
    return this.#contain(resolve(this.indexDir(userId), 'chats.json'));
  }

  attachmentsDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'attachments'));
  }

  systemDir(): string {
    return this.#contain(resolve(this.#root, SYSTEM_DIR));
  }

  /**
   * Extracts a conversation id from a chats/ filename, or `null` when the name
   * is not one we own. Used when scanning the directory to rebuild the index;
   * unknown entries are ignored, never deleted (contracts §1).
   */
  static conversationIdFromFilename(filename: string): string | null {
    if (!filename.endsWith('.md')) return null;
    const id = filename.slice(0, -3);
    return isCanonicalUuid(id) ? id : null;
  }

  /**
   * Whether a top-level entry under `data/` is one we recognise. Anything else
   * is ignored and logged at startup, and never removed (contracts §1).
   */
  static isKnownTopLevelEntry(name: string): boolean {
    return name === SYSTEM_DIR || name === '.gitkeep' || isCanonicalUuid(name);
  }
}
