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

    const created = entries.map((entry) => ({
      ...entry,
      id: randomUUID(),
      createdAt: now().toISOString(),
    }));

    return this.#locks.run(proposalsKey(userId, conversationId), async () => {
      const existing = await this.list(userId, conversationId);
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
