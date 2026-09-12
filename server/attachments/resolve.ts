import { REQUIRED_MODALITY } from '@shared/attachment.ts';
import type { Conversation } from '@shared/conversation.ts';
import type { ResolvedAttachment } from '../generation/prompt.ts';
import type { AttachmentStore } from './store.ts';

/**
 * Reads the attachments a conversation refers to, ready for a prompt.
 *
 * Separate from assembly because assembly is pure: it does budget arithmetic
 * and must not depend on what the filesystem says this second. Everything that
 * can fail, or be slow, or be missing, happens here — and an attachment that
 * cannot be read is simply left out of the map, which is what turns a deleted
 * file into a skipped part rather than a conversation nobody can continue
 * (contracts §7).
 */

export interface ResolveOptions {
  /** Characters of a text attachment to inline before cutting it short. */
  maxInlineChars: number;
  /**
   * What the model can take in, from discovery.
   *
   * Used to skip reading bytes the model could not be sent anyway — a 10 MB
   * image base64-encoded for a model that cannot see is pure cost.
   */
  modalities: readonly string[];
}

/** Every attachment id mentioned by any user message, in order, deduplicated. */
export function referencedIds(conversation: Conversation): string[] {
  const seen = new Set<string>();
  for (const message of conversation.messages) {
    if (message.type !== 'user') continue;
    for (const id of message.attachments ?? []) seen.add(id);
  }
  return [...seen];
}

export async function resolveAttachments(
  store: AttachmentStore,
  userId: string,
  conversation: Conversation,
  { maxInlineChars, modalities }: ResolveOptions
): Promise<Map<string, ResolvedAttachment>> {
  const resolved = new Map<string, ResolvedAttachment>();

  for (const id of referencedIds(conversation)) {
    let meta;
    try {
      meta = await store.read(userId, id);
    } catch {
      // Deleted, or never finished uploading. The message keeps its reference
      // and the UI shows a placeholder; the prompt simply does without it.
      continue;
    }

    const needed = REQUIRED_MODALITY[meta.kind];
    if (needed !== null && !modalities.includes(needed)) continue;

    try {
      const bytes = await store.bytes(userId, id);

      if (meta.kind === 'text') {
        /*
         * Truncated by characters rather than bytes, and only for the prompt.
         * What is stored is never altered — a reader who downloads the file
         * gets all of it, and the cut only exists because a 10 MB log would
         * otherwise consume a context window on its own.
         */
        const full = bytes.toString('utf8');
        const content = full.slice(0, maxInlineChars);
        resolved.set(id, {
          id,
          filename: meta.filename,
          kind: 'text',
          mediaType: meta.mediaType,
          content,
          truncated: content.length < full.length,
        });
        continue;
      }

      resolved.set(id, {
        id,
        filename: meta.filename,
        kind: meta.kind,
        mediaType: meta.mediaType,
        /*
         * An image goes as a `data:` URL and audio as bare base64, because
         * that is what each content part takes. Never a remote URL: that would
         * make the provider fetch a destination the client chose
         * (docs/provider-notes.md §9).
         */
        content:
          meta.kind === 'image'
            ? `data:${meta.mediaType};base64,${bytes.toString('base64')}`
            : bytes.toString('base64'),
        truncated: false,
      });
    } catch {
      // Metadata without readable bytes: the same case as above, one step later.
      continue;
    }
  }

  return resolved;
}
