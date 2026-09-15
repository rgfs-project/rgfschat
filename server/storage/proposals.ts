import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile, ensureDir } from './atomic.ts';
import { KeyedLock } from './locks.ts';
import type { StoragePaths } from './paths.ts';
import { isMemoryName } from './paths.ts';
import type { Logger } from '../logger.ts';

/**
 * Memory changes the model has asked for and the reader has not yet answered.
 *
 * `data/<user>/proposals/<conversation>.json`, one file per conversation.
 *
 * This is **disposable state**, in the same sense as a generation checkpoint
 * and unlike anything under `chats/`: the Markdown is the record of what was
 * said, and a question waiting on a click is not that. Once a proposal is
 * answered it is deleted — an accepted one leaves a memory file, which is the
 * durable trace, and a rejected one is meant to leave nothing at all.
 *
 * A proposal outliving a reload is the reason it is on disk rather than held in
 * the generation record: the run that produced it is evicted after ten minutes,
 * and a reader who closed the tab should still be asked.
 */

export type ProposalOperation = 'create' | 'update' | 'delete';

export interface MemoryProposal {
  id: string;
  /** The assistant turn that asked, so the UI can put it under that message. */
  assistantMessageId: string;
  operation: ProposalOperation;
  name: string;
  /** Absent for a deletion. */
  content?: string;
  /**
   * What produced it: `<generationId>:<toolCallId>`.
   *
   * The identity a duplicate is recognised by. A run that is retried, a
   * completion processed twice, or a recovery pass after a restart all arrive
   * with the same generation and the same call, and a second card for one call
   * is a question the reader is asked twice.
   */
  sourceId?: string;
  /**
   * The target memory's `updatedAt` when the proposal was made, for an update
   * or a deletion. Absent when there was no such memory then — and absent on
   * proposals written before this field existed, which the caller treats as
   * "compare against `createdAt`" rather than as "no check".
   */
  baseUpdatedAt?: string;
  createdAt: string;
}

const schema = z.strictObject({
  id: z.string(),
  assistantMessageId: z.string(),
  operation: z.enum(['create', 'update', 'delete']),
  // Re-validated on read, not merely on write: this file is on a disk a person
  // can edit, and the name becomes a filename when the proposal is accepted.
  name: z.string().refine(isMemoryName),
  content: z.string().optional(),
  sourceId: z.string().optional(),
  baseUpdatedAt: z.string().optional(),
  createdAt: z.string(),
});

const fileSchema = z.strictObject({ proposals: z.array(schema) });

/**
 * How many may be outstanding in one conversation.
 *
 * A bound on what an enthusiastic model can pile up in front of a reader who
 * has not answered the first one. Past it, the oldest are dropped — the newest
 * proposal is the one the conversation is actually about.
 */
const MAX_PENDING_PER_CONVERSATION = 32;

/**
 * Lock key for one conversation's proposals.
 *
 * A namespace of its own rather than the conversation's key, so taking this
 * while already holding the conversation lock — which is what happens when a
 * finished generation files its proposals — is not a self-deadlock. Nothing
 * takes the two in the other order.
 */
function proposalsKey(userId: string, conversationId: string): string {
  return `proposals:${userId}/${conversationId}`;
}

export class ProposalStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #locks: KeyedLock;

  constructor(paths: StoragePaths, logger: Logger, locks: KeyedLock = new KeyedLock()) {
    this.#paths = paths;
    this.#logger = logger;
    this.#locks = locks;
  }

  /** Everything still unanswered in one conversation, oldest first. */
  async list(userId: string, conversationId: string): Promise<MemoryProposal[]> {
    let raw: string;
    try {
      raw = await readFile(this.#paths.proposalsFile(userId, conversationId), 'utf8');
    } catch {
      return [];
    }

    try {
      const parsed = fileSchema.parse(JSON.parse(raw));
      // Rebuilt rather than returned as parsed: zod spells an absent optional
      // as `string | undefined`, which under `exactOptionalPropertyTypes` is a
      // different type from the absent property this interface declares.
      return parsed.proposals.map((proposal) => ({
        id: proposal.id,
        assistantMessageId: proposal.assistantMessageId,
        operation: proposal.operation,
        name: proposal.name,
        ...(proposal.content === undefined ? {} : { content: proposal.content }),
        ...(proposal.sourceId === undefined ? {} : { sourceId: proposal.sourceId }),
        ...(proposal.baseUpdatedAt === undefined ? {} : { baseUpdatedAt: proposal.baseUpdatedAt }),
        createdAt: proposal.createdAt,
      }));
    } catch {
      /*
       * Unreadable is treated as empty rather than as an error. These are
       * pending questions, not history: losing them costs the reader a prompt
       * they never saw, where failing the conversation load over them would
       * cost the conversation.
       */
      this.#logger.warn('Discarding an unreadable proposals file', { conversationId });
      return [];
    }
  }

  /** Adds proposals to a conversation, returning the ones actually stored. */
  async add(
    userId: string,
    conversationId: string,
    entries: readonly Omit<MemoryProposal, 'id' | 'createdAt'>[],
    now: () => Date = () => new Date()
  ): Promise<MemoryProposal[]> {
    if (entries.length === 0) return [];

    return this.#locks.run(proposalsKey(userId, conversationId), async () => {
      const existing = await this.list(userId, conversationId);

      /*
       * A call that has already been filed is not filed again.
       *
       * Checked under the lock and against what is on disk, because the
       * duplicate arrives from another process lifetime as readily as from
       * this one: the same generation retried, its completion handled twice, a
       * reconnect, a recovery pass after a restart. Entries with no `sourceId`
       * — nothing else produces them now — are always kept.
       */
      const seen = new Set(
        existing
          .map((proposal) => proposal.sourceId)
          .filter((sourceId): sourceId is string => sourceId !== undefined)
      );
      const fresh = entries.filter(
        (entry) => entry.sourceId === undefined || !seen.has(entry.sourceId)
      );
      if (fresh.length === 0) return [];

      const created = fresh.map((entry) => ({
        ...entry,
        id: randomUUID(),
        createdAt: now().toISOString(),
      }));

      const all = [...existing, ...created].slice(-MAX_PENDING_PER_CONVERSATION);

      await this.#write(userId, conversationId, all);
      this.#logger.info('Memory proposals recorded', {
        userId,
        conversationId,
        count: created.length,
      });

      return created;
    });
  }

  /**
   * Takes one out, returning it. `null` when it was already answered or gone.
   *
   * Removal and the answer it belongs to are one step on purpose: the caller
   * applies the memory change only for a proposal this actually handed back, so
   * two clicks on the same card cannot write the memory twice.
   *
   * Prefer `resolve` when the answer can fail. This removes first, which is
   * right for a rejection — there is nothing after it that can go wrong — and
   * wrong for an acceptance, which is issue 1.
   */
  async take(
    userId: string,
    conversationId: string,
    proposalId: string
  ): Promise<MemoryProposal | null> {
    return this.#locks.run(proposalsKey(userId, conversationId), async () => {
      const existing = await this.list(userId, conversationId);
      const found = existing.find((proposal) => proposal.id === proposalId);
      if (found === undefined) return null;

      await this.#write(
        userId,
        conversationId,
        existing.filter((proposal) => proposal.id !== proposalId)
      );
      return found;
    });
  }

  /**
   * Applies an answer to one proposal, and removes it **only if that worked**.
   *
   * `take` followed by a write is not the same thing, and the difference is a
   * bug a reader pays for: a memory that is refused on size, on the total
   * quota, or by a full disk leaves them with no note *and* no card to try
   * again from — the model's suggestion is simply gone, with an error toast
   * where it used to be. So `apply` runs first and a throw leaves the proposal
   * exactly where it was; the reader sees why, and can click again once the
   * cause is dealt with.
   *
   * Both halves run under the conversation's proposal lock, which is what
   * makes a double click safe in the other direction too: the second caller
   * finds nothing and is told so, rather than applying the same change twice.
   *
   * Returns `null` for a proposal that was already answered.
   */
  async resolve<T>(
    userId: string,
    conversationId: string,
    proposalId: string,
    apply: (proposal: MemoryProposal) => Promise<T>
  ): Promise<{ proposal: MemoryProposal; result: T } | null> {
    return this.#locks.run(proposalsKey(userId, conversationId), async () => {
      const existing = await this.list(userId, conversationId);
      const found = existing.find((proposal) => proposal.id === proposalId);
      if (found === undefined) return null;

      // Deliberately outside a try: a rejection propagates to the caller with
      // the file untouched, which is the entire point of this method.
      const result = await apply(found);

      await this.#write(
        userId,
        conversationId,
        existing.filter((proposal) => proposal.id !== proposalId)
      );

      return { proposal: found, result };
    });
  }

  /**
   * Drops the proposals an assistant turn made, for when that turn goes.
   *
   * Regenerating replaces the assistant message, and an edit or a delete
   * removes it. The proposals it made go with it: a card offering to save
   * something out of a reply that is no longer in the conversation is a
   * question with no context, and accepting it would write a memory on the
   * strength of text the reader can no longer read.
   *
   * Resolves to how many were dropped.
   */
  async removeForMessage(
    userId: string,
    conversationId: string,
    assistantMessageId: string
  ): Promise<number> {
    return this.#locks.run(proposalsKey(userId, conversationId), async () => {
      const existing = await this.list(userId, conversationId);
      const kept = existing.filter(
        (proposal) => proposal.assistantMessageId !== assistantMessageId
      );
      if (kept.length === existing.length) return 0;

      await this.#write(userId, conversationId, kept);
      return existing.length - kept.length;
    });
  }

  /**
   * Drops every proposal whose turn is no longer in the conversation.
   *
   * The backstop behind `removeForMessage`, and the reason an orphan can never
   * be *served*: a proposal is filed as its run finishes and the message is
   * written under the conversation's lock, so a crash in between — or a
   * conversation edited by hand on disk — can leave a card pointing at nothing.
   * Called on the read path with the ids the conversation actually has, so the
   * invariant holds at the only moment it is observable.
   *
   * Resolves to the proposals that survived.
   */
  async retainMessages(
    userId: string,
    conversationId: string,
    messageIds: ReadonlySet<string>
  ): Promise<MemoryProposal[]> {
    return this.#locks.run(proposalsKey(userId, conversationId), async () => {
      const existing = await this.list(userId, conversationId);
      const kept = existing.filter((proposal) => messageIds.has(proposal.assistantMessageId));
      if (kept.length === existing.length) return existing;

      this.#logger.info('Dropping proposals whose message is gone', {
        userId,
        conversationId,
        dropped: existing.length - kept.length,
      });
      await this.#write(userId, conversationId, kept);
      return kept;
    });
  }

  /** Drops every proposal in a conversation, for when the conversation goes. */
  async clear(userId: string, conversationId: string): Promise<void> {
    await unlink(this.#paths.proposalsFile(userId, conversationId)).catch(() => undefined);
  }

  async #write(userId: string, conversationId: string, proposals: MemoryProposal[]): Promise<void> {
    // An empty list is a deleted file rather than an empty array, so a
    // conversation nobody proposed anything in costs no file at all.
    if (proposals.length === 0) {
      await this.clear(userId, conversationId);
      return;
    }

    await ensureDir(this.#paths.proposalsDir(userId));
    await atomicWriteFile(
      this.#paths.proposalsFile(userId, conversationId),
      `${JSON.stringify({ proposals }, null, 2)}\n`
    );
  }
}
