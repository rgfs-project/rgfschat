import { isTerminal } from '@shared/generation.ts';
import { isCanonicalTimestamp, type AssistantMessage } from '@shared/conversation.ts';
import type { Logger } from '../logger.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import { entryFor, type ChatIndex } from '../storage/index.ts';
import { conversationKey } from '../storage/locks.ts';
import type { CheckpointStore } from './checkpoints.ts';

/**
 * Restart policy (INV-21).
 *
 * In-flight generations do not survive a restart — there is no process left
 * streaming them. What must survive is the *honesty* of the record: a user who
 * saw half a reply appear should find that half on disk, marked as interrupted,
 * rather than either a lie of omission or a message pretending to be complete.
 *
 * So at startup, **before the server accepts requests**, every non-terminal
 * checkpoint has its partial output appended with `status=interrupted`, and the
 * checkpoint is then removed.
 *
 * Crash-safety between those two steps is the subtle part. If the process dies
 * after the Markdown write but before the checkpoint is cleared, a second run
 * would append the same message twice. The scan therefore checks whether an
 * assistant message with that id is *already present* and skips the write if so
 * — the assistant message is written exactly once however many times recovery
 * runs (INV-07).
 */

export interface RecoveryResult {
  /** Non-terminal checkpoints that were finished as interrupted. */
  interrupted: number;
  /** Checkpoints skipped because the message was already on disk. */
  alreadyWritten: number;
  /** Terminal or unusable checkpoints simply cleared. */
  cleared: number;
}

export interface RecoveryOptions {
  checkpoints: CheckpointStore;
  store: ConversationStore;
  index: ChatIndex;
  logger: Logger;
}

export async function recoverGenerations({
  checkpoints,
  store,
  index,
  logger,
}: RecoveryOptions): Promise<RecoveryResult> {
  const result: RecoveryResult = { interrupted: 0, alreadyWritten: 0, cleared: 0 };

  for (const checkpoint of await checkpoints.list()) {
    if (isTerminal(checkpoint.state)) {
      // It already reached a terminal state, so the assistant block was written
      // by the normal path. Nothing to recover.
      await checkpoints.remove(checkpoint.generationId);
      result.cleared += 1;
      continue;
    }

    try {
      await store.locks.run(
        conversationKey(checkpoint.ownerId, checkpoint.conversationId),
        async () => {
          if (!(await store.exists(checkpoint.ownerId, checkpoint.conversationId))) {
            // The conversation was deleted while the generation ran; its output
            // is discarded rather than resurrecting the file.
            logger.info('Discarding checkpoint for a deleted conversation', {
              generationId: checkpoint.generationId,
            });
            result.cleared += 1;
            return;
          }

          const conversation = await store.load(checkpoint.ownerId, checkpoint.conversationId);

          // Idempotency: a crash between the Markdown write and clearing the
          // checkpoint must not append the message a second time.
          if (conversation.messages.some((m) => m.id === checkpoint.assistantMessageId)) {
            logger.info('Checkpoint already reflected in the conversation; skipping', {
              generationId: checkpoint.generationId,
            });
            result.alreadyWritten += 1;
            return;
          }

          const assistant: AssistantMessage = {
            type: 'assistant',
            id: checkpoint.assistantMessageId,
            status: 'interrupted',
            provider: checkpoint.providerId,
            model: checkpoint.model,
            ...(checkpoint.reasoning !== '' ? { reasoning: checkpoint.reasoning } : {}),
            // The checkpoint's own clock, not this one. Recovery runs at the
            // next startup, which may be days after the crash, and the half a
            // reply being filed was written when it was written. A checkpoint
            // whose timestamp is not canonical is written without a time
            // rather than with one the parser would then reject.
            ...(isCanonicalTimestamp(checkpoint.updatedAt) ? { time: checkpoint.updatedAt } : {}),
            body: checkpoint.content,
          };

          const written = await store.writeUnderLock(
            checkpoint.ownerId,
            checkpoint.conversationId,
            { ...conversation, messages: [...conversation.messages, assistant] }
          );
          await index.upsert(checkpoint.ownerId, entryFor(checkpoint.conversationId, written));

          result.interrupted += 1;
          logger.info('Recovered an interrupted generation', {
            generationId: checkpoint.generationId,
            contentLength: checkpoint.content.length,
          });
        }
      );
    } catch (err) {
      // A conversation that cannot be written (malformed, for instance) must
      // not block startup; the checkpoint is left for a human to inspect.
      logger.error('Failed to recover a generation checkpoint', {
        generationId: checkpoint.generationId,
        error: err instanceof Error ? { name: err.name, message: err.message } : undefined,
      });
      continue;
    }

    await checkpoints.remove(checkpoint.generationId);
  }

  return result;
}
