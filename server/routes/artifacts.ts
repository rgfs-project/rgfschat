import { Router, type Request } from 'express';
import {
  artifactFilename,
  artifactId,
  deriveTitle,
  extractCodeBlocks,
  isArtifact,
  parseArtifactId,
  type ArtifactSummary,
} from '@shared/artifact.ts';
import { isCanonicalUuid } from '@shared/conversation.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { ChatIndex } from '../storage/index.ts';
import { AppError } from '../errors/AppError.ts';

/**
 * The artifact gallery: every code block the caller has, across conversations.
 *
 * Derived on read, never stored. There is no artifact table to keep in step
 * with the Markdown, so there is nothing that can disagree with it — deleting a
 * message removes its artifacts, editing one re-derives them, and a restored
 * backup lists correctly the first time it is read. The conversation Markdown
 * is frozen (contracts §3) and this feature does not touch it.
 *
 * The scan mirrors search: walk the caller's index, `inspect` each conversation
 * rather than `load` it, and skip what will not parse. One unreadable file must
 * not fail the gallery for every other conversation.
 */

/** Bounds the response. The gallery is for finding things, not for archiving. */
const ARTIFACT_LIMIT = 200;

export interface ArtifactsDeps {
  store: ConversationStore;
  index: ChatIndex;
}

function ownerOf(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

export function artifactsRouter({ store, index }: ArtifactsDeps): Router {
  const router = Router();

  router.get('/artifacts', async (req, res) => {
    const user = ownerOf(req);
    const artifacts: ArtifactSummary[] = [];

    // Newest conversation first, so the cap drops the oldest rather than
    // whatever the index happened to list last.
    const entries = [...(await index.list(user))].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );

    for (const entry of entries) {
      if (entry.malformed) continue;

      const found = await store.inspect(user, entry.id);
      if (!found.ok) continue;

      for (const message of found.conversation.messages) {
        // System prompts are not shown in the transcript and reasoning is a
        // model's scratch space; an artifact has to be something the reader can
        // open where it came from.
        if (message.type !== 'user' && message.type !== 'assistant') continue;

        for (const block of extractCodeBlocks(message.body)) {
          if (!isArtifact(block)) continue;

          artifacts.push({
            id: artifactId(message.id, block.ordinal),
            conversationId: entry.id,
            conversationTitle: entry.title,
            messageId: message.id,
            title: deriveTitle(block.language, block.code),
            language: block.language,
            lines: block.code.trim().split('\n').length,
            updatedAt: found.conversation.updatedAt,
          });
        }
      }

      if (artifacts.length >= ARTIFACT_LIMIT) break;
    }

    res.json({ artifacts: artifacts.slice(0, ARTIFACT_LIMIT) });
  });

  /**
   * One artifact, as a file to save.
   *
   * Re-derived from the Markdown on each request, like the list — there is no
   * stored copy that could drift from the message it came from.
   *
   * Served as `text/plain` whatever the block's language is, and always as an
   * attachment. The content is model- or user-authored: a block tagged `html`
   * returned as `text/html` from this origin would be a stored-XSS delivery
   * route straight past the CSP that protects the rest of the app. The same
   * reasoning, and the same headers, as the attachment download route.
   */
  router.get('/conversations/:conversationId/artifacts/:artifactId/download', async (req, res) => {
    const user = ownerOf(req);

    const conversationId = req.params.conversationId;
    if (!isCanonicalUuid(conversationId)) throw AppError.notFound('Conversation not found.');

    const address = parseArtifactId(req.params.artifactId);
    if (address === null) throw AppError.notFound('Artifact not found.');

    const found = await store.inspect(user, conversationId);
    if (!found.ok) throw AppError.notFound('Conversation not found.');

    const message = found.conversation.messages.find(
      (candidate) => candidate.id === address.messageId
    );
    if (message === undefined || (message.type !== 'user' && message.type !== 'assistant')) {
      throw AppError.notFound('Artifact not found.');
    }

    const block = extractCodeBlocks(message.body).find((b) => b.ordinal === address.ordinal);
    if (block === undefined || !isArtifact(block)) throw AppError.notFound('Artifact not found.');

    const filename = artifactFilename(deriveTitle(block.language, block.code), block.language);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    // Belt and braces beside the global nosniff: nothing here is to be run.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(block.code);
  });

  return router;
}
