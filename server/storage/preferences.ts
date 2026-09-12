import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { atomicWriteFile, ensureDir } from './atomic.ts';
import { KeyedLock } from './locks.ts';
import type { StoragePaths } from './paths.ts';
import type { Logger } from '../logger.ts';

/**
 * Per-reader preferences (`data/<user>/preferences.json`).
 *
 * Pinning is a property of the reader's view of a conversation, not of the
 * conversation, and it has nowhere else to live: the Markdown's front matter is
 * frozen at four keys (contracts §3), and the chat index is derived and may be
 * rebuilt from disk at any moment (INV-11), so authoritative state cannot sit
 * in either. This file is small, owned by one user, and written the same
 * atomic way everything else is.
 *
 * A missing or unreadable file means "no preferences", never an error. Losing
 * which conversations were pinned is a small, self-correcting inconvenience;
 * refusing to list conversations because a preferences file went bad would not
 * be.
 */

export const PREFERENCES_VERSION = 1;

const modelSchema = z.strictObject({
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(400),
});

export type DefaultModel = z.infer<typeof modelSchema>;

const fileSchema = z.strictObject({
  version: z.literal(PREFERENCES_VERSION),
  /** Conversation ids, most recently pinned first. */
  pinned: z.array(z.string()),
  /**
   * Which model this reader starts a conversation on.
   *
   * Optional, and read back leniently: a model that has since been removed or
   * hidden is not an error here. The client falls back the same way it does
   * for a reader who has never chosen one, and the server checks the pair on
   * every generation regardless (INV-18).
   */
  defaultModel: modelSchema.optional(),
});

export interface Preferences {
  pinned: Set<string>;
  defaultModel: DefaultModel | null;
}

export class PreferencesStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #locks = new KeyedLock();

  constructor(paths: StoragePaths, logger: Logger) {
    this.#paths = paths;
    this.#logger = logger;
  }

  /** Everything stored for one reader, with absent and unreadable alike. */
  async read(userId: string): Promise<Preferences> {
    const file = this.#paths.preferencesFile(userId);

    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return { pinned: new Set(), defaultModel: null };
    }

    try {
      const parsed = fileSchema.parse(JSON.parse(raw) as unknown);
      return {
        // Filtered on the way out: a hand-edited file cannot put something
        // that is not an id into a path later on.
        pinned: new Set(parsed.pinned.filter((id) => isCanonicalUuid(id))),
        defaultModel: parsed.defaultModel ?? null,
      };
    } catch {
      this.#logger.warn('Preferences file is unreadable; ignoring it', { userId });
      return { pinned: new Set(), defaultModel: null };
    }
  }

  /** The set of pinned conversation ids, ignoring anything unreadable. */
  async pinned(userId: string): Promise<Set<string>> {
    return (await this.read(userId)).pinned;
  }

  /**
   * Sets or clears this reader's default model.
   *
   * Under the same lock as pinning, because both rewrite the one file: without
   * it, pinning a conversation while a model choice is in flight drops
   * whichever landed first.
   */
  async setDefaultModel(userId: string, model: DefaultModel | null): Promise<void> {
    await this.#locks.run(`preferences:${userId}`, async () => {
      const current = await this.read(userId);
      await this.#write(userId, {
        pinned: current.pinned,
        defaultModel: model,
      });
    });
  }

  /**
   * Pins or unpins one conversation.
   *
   * Under a lock keyed on the user, because two rapid clicks on two different
   * rows are otherwise a read-modify-write race that loses one of them.
   */
  async setPinned(userId: string, conversationId: string, pinned: boolean): Promise<Set<string>> {
    return this.#locks.run(`preferences:${userId}`, async () => {
      const current = await this.read(userId);
      if (pinned) current.pinned.add(conversationId);
      else current.pinned.delete(conversationId);

      await this.#write(userId, current);
      return current.pinned;
    });
  }

  async #write(userId: string, next: Preferences): Promise<void> {
    await ensureDir(this.#paths.userDir(userId));
    await atomicWriteFile(
      this.#paths.preferencesFile(userId),
      `${JSON.stringify(
        {
          version: PREFERENCES_VERSION,
          pinned: [...next.pinned],
          ...(next.defaultModel === null ? {} : { defaultModel: next.defaultModel }),
        },
        null,
        2
      )}\n`
    );
  }

  /** Drops a conversation from the pins, for when it is deleted. */
  async forget(userId: string, conversationId: string): Promise<void> {
    const current = await this.pinned(userId);
    if (!current.has(conversationId)) return;
    await this.setPinned(userId, conversationId, false);
  }
}
