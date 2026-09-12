import type { ChatIndex } from '../storage/index.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { Logger } from '../logger.ts';
import type { AttachmentStore } from './store.ts';
import { referencedIds } from './resolve.ts';

/**
 * Repairs what a crash can leave behind, at startup.
 *
 * There is exactly one window that needs this. A message is written to
 * canonical Markdown and its attachments are marked linked immediately
 * afterwards; a process that dies between the two leaves attachments that are
 * still *pending* while a message already refers to them. Left alone the sweep
 * would eventually collect them, and a conversation would quietly lose the file
 * it was about.
 *
 * So the Markdown is the authority, as it is everywhere else: whatever a user
 * message says it carries is linked, whether or not the previous process got
 * that far. Linking is idempotent for the same message, so this is safe to run
 * on every boot and safe to run twice.
 *
 * Nothing is deleted here. An attachment nobody references is the sweep's
 * business and has its own TTL; conflating the two would mean a bug in this
 * scan could destroy files rather than merely fail to adopt them.
 */
export async function reconcileAttachments(options: {
  attachments: AttachmentStore;
  store: ConversationStore;
  index: ChatIndex;
  userId: string;
  logger: Logger;
}): Promise<{ linked: number }> {
  const { attachments, store, index, userId, logger } = options;

  // Only conversations that exist; a malformed one cannot be read for its
  // references and is left exactly as it is (INV-10).
  let conversationIds: string[];
  try {
    conversationIds = (await index.list(userId)).map((entry) => entry.id);
  } catch {
    return { linked: 0 };
  }

  let linked = 0;

  for (const conversationId of conversationIds) {
    let conversation;
    try {
      conversation = await store.load(userId, conversationId);
    } catch {
      continue;
    }

    if (referencedIds(conversation).length === 0) continue;

    for (const message of conversation.messages) {
      if (message.type !== 'user') continue;
      const ids = message.attachments ?? [];
      if (ids.length === 0) continue;

      for (const id of ids) {
        try {
          const meta = await attachments.read(userId, id);
          if (meta.messageId !== null) continue;

          await attachments.link(userId, [id], conversationId, message.id);
          linked += 1;
        } catch {
          /*
           * Referenced but absent, or already claimed by a different message.
           * Neither is repairable from here and neither is fatal: the first
           * renders as a missing-attachment placeholder, and the second is a
           * conflict a scan must not resolve by guessing.
           */
        }
      }
    }
  }

  if (linked > 0) {
    logger.info('Adopted attachments referenced by stored messages', { linked });
  }
  return { linked };
}
