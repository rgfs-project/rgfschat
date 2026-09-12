import type { GenerationManager } from '../generation/manager.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { ChatIndex } from '../storage/index.ts';

/**
 * Deletes one account's conversations, optionally only the recent ones.
 *
 * One implementation, called from the admin panel's maintenance section and
 * from a reader's own settings. Two copies of a routine that unlinks files
 * with no undo is one copy too many: the version that gets a fix is not
 * necessarily the version a given button calls.
 *
 * It takes a single owner and has no "everyone" form, which is the shape the
 * bug it replaced depended on.
 */

export interface ClearHistoryResult {
  deleted: number;
  cancelled: number;
}

export async function clearHistoryFor(
  owner: string,
  options: {
    store: ConversationStore;
    index: ChatIndex;
    manager: GenerationManager;
    /** Only conversations touched within this many hours; absent means all. */
    withinHours?: number | undefined;
  }
): Promise<ClearHistoryResult> {
  const { store, index, manager, withinHours } = options;
  const cutoff = withinHours === undefined ? null : Date.now() - withinHours * 60 * 60 * 1000;

  /*
   * Anything running belongs to a conversation inside the window by definition
   * — it is being written to right now — so it is stopped before the files go,
   * rather than left writing into a deleted conversation (INV-17).
   */
  const cancelled = manager.cancelAllForOwner(owner);

  let deleted = 0;
  const entries = await index.list(owner).catch(() => []);

  for (const entry of entries) {
    if (cutoff !== null) {
      const touched = Date.parse(entry.updatedAt);
      // An unparseable timestamp is left alone: a window is a claim about when
      // something happened, and we cannot make that claim here.
      if (!Number.isFinite(touched) || touched < cutoff) continue;
    }

    await store.delete(owner, entry.id);
    await index.remove(owner, entry.id);
    deleted += 1;
  }

  return { deleted, cancelled };
}
