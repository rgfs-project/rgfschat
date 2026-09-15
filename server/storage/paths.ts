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

/** The only shape a memory's name may take, on disk and over the API. */
const MEMORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MEMORY_NAME_MAX_LENGTH = 64;

export function isMemoryName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MEMORY_NAME_MAX_LENGTH &&
    MEMORY_NAME.test(value)
  );
}

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

  /**
   * `data/<user>/preferences.json` — small, authoritative, the reader's own.
   *
   * Which conversations are pinned cannot live in the conversation file: that
   * format is frozen at four front-matter keys (contracts §3). Nor in the chat
   * index, which is derived and may be deleted and rebuilt at any time. So it
   * has a file of its own, beside them and belonging to neither.
   */
  preferencesFile(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'preferences.json'));
  }

  /**
   * `data/<user>/memories/<name>.md` — one note, editable by hand.
   *
   * The name is request-controlled, so it is validated rather than escaped
   * (INV-12): lowercase letters, digits and single hyphens, which is also what
   * makes a memory's name usable as its identity in the API.
   */
  memoryFile(userId: string, name: string): string {
    if (!isMemoryName(name)) throw AppError.internal('Invalid memory name for path construction');
    return this.#contain(resolve(this.memoriesDir(userId), `${name}.md`));
  }

  memoriesDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'memories'));
  }

  /**
   * `data/<user>/proposals/<conversation>.json` — memory changes the model has
   * asked for and the reader has not yet answered.
   *
   * Disposable state, like a generation checkpoint and unlike anything in
   * `chats/`: the conversation Markdown is the record of what was *said*, and a
   * question waiting on a click is not that. Keeping it out also means the
   * canonical format — frozen at the attributes in contracts §3.4 — does not
   * have to grow a field for it.
   *
   * Keyed by conversation rather than by proposal because that is how it is
   * read: opening a conversation asks "is anything pending here", which is one
   * file rather than a scan.
   */
  proposalsFile(userId: string, conversationId: string): string {
    if (!isCanonicalUuid(conversationId)) {
      throw AppError.internal('Invalid conversation id for path construction');
    }
    return this.#contain(resolve(this.proposalsDir(userId), `${conversationId}.json`));
  }

  proposalsDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'proposals'));
  }

  attachmentsDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'attachments'));
  }

  /**
   * `data/<user>/attachments/<attachment>/` — one directory per attachment.
   *
   * A directory rather than two files side by side, so the bytes and their
   * metadata are removed together by a single `rm`, and so a half-written
   * upload is a directory with no `meta.json` rather than a stray blob
   * indistinguishable from a real one.
   *
   * The id is a server-minted UUID and is the *only* thing that reaches this
   * path. The uploaded filename never does (INV-28): it is display metadata,
   * stored inside `meta.json` where it cannot be interpreted as a location.
   */
  attachmentDir(userId: string, attachmentId: string): string {
    const id = this.#segment(attachmentId, 'attachment id');
    return this.#contain(resolve(this.attachmentsDir(userId), id));
  }

  /** The bytes, exactly as uploaded and never rewritten. */
  attachmentBlob(userId: string, attachmentId: string): string {
    return this.#contain(resolve(this.attachmentDir(userId, attachmentId), 'blob'));
  }

  /** Canonical metadata, written last so its presence means "complete". */
  attachmentMetaFile(userId: string, attachmentId: string): string {
    return this.#contain(resolve(this.attachmentDir(userId, attachmentId), 'meta.json'));
  }

  artifactsDir(userId: string): string {
    return this.#contain(resolve(this.userDir(userId), 'artifacts'));
  }

  /**
   * `data/<user>/artifacts/<artifact>/` — one directory per artifact.
   *
   * Shaped like an attachment rather than like a memory: an artifact is a file
   * plus metadata that will not fit in a filename — the type it was written
   * as, the conversation it came from, the description it was presented with.
   * A directory keeps the two together, so one `rm` removes both and a
   * half-written import is a directory with no `meta.json` rather than a stray
   * file nothing claims.
   *
   * The id is a server-minted UUID and is the only thing that reaches this
   * path. The artifact's own name never does — it comes from a tool call in
   * somebody's export, which makes it exactly the kind of string that must not
   * become a location (INV-28).
   */
  artifactDir(userId: string, artifactId: string): string {
    const id = this.#segment(artifactId, 'artifact id');
    return this.#contain(resolve(this.artifactsDir(userId), id));
  }

  /** The artifact's own bytes, as they were written. */
  artifactBlob(userId: string, artifactId: string): string {
    return this.#contain(resolve(this.artifactDir(userId, artifactId), 'blob'));
  }

  /** Canonical metadata, written last so its presence means "complete". */
  artifactMetaFile(userId: string, artifactId: string): string {
    return this.#contain(resolve(this.artifactDir(userId, artifactId), 'meta.json'));
  }

  /** Administrative audit logs, one file per month. */
  auditDir(): string {
    return this.#contain(resolve(this.systemDir(), 'audit'));
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
