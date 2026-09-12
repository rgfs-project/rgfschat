import { Router, type Request } from 'express';
import { z } from 'zod';
import { TITLE_MAX_LENGTH, type Conversation } from '@shared/conversation.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import { entryFor, type ChatIndex, type ChatIndexEntry } from '../storage/index.ts';
import type { PreferencesStore } from '../storage/preferences.ts';
import { referencedIds } from '../attachments/resolve.ts';
import type { AttachmentStore } from '../attachments/store.ts';
import { validateBody } from '../http/validate.ts';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';

/**
 * Conversation CRUD.
 *
 * The user-directory segment always comes from server-side identity, never from
 * the request (INV-14). In Phase 3 that is `config.localUserId`; from Phase 4 it
 * is the authenticated session.
 */

const titleSchema = z
  .string()
  .min(1)
  .max(TITLE_MAX_LENGTH)
  .refine((value) => !/[\r\n]/.test(value), 'title must not contain line breaks');

// `createdAt` and `updatedAt` are storage-owned. Because every schema is strict,
// a client that sends either is rejected rather than silently ignored.
const createSchema = z.strictObject({ title: titleSchema.optional() });
const patchSchema = z.strictObject({ title: titleSchema });
const editMessageSchema = z.strictObject({ body: z.string().min(1).max(200_000) });
const pinSchema = z.strictObject({ pinned: z.boolean() });

/** Long enough for a sentence someone half-remembers, short enough to bound. */
const SEARCH_QUERY_MAX_LENGTH = 200;
const SEARCH_RESULT_LIMIT = 30;
const HITS_PER_CONVERSATION = 3;
/** Characters of context each side of a match. */
const SNIPPET_RADIUS = 60;

export interface SearchHit {
  messageId: string;
  type: 'user' | 'assistant';
  snippet: string;
}

export interface SearchResult {
  id: string;
  title: string;
  updatedAt: string;
  /** The title matched too, so the conversation is worth offering on its own. */
  titleMatch: boolean;
  hits: SearchHit[];
}

/**
 * A line of context around a match.
 *
 * Whitespace is collapsed because a message is Markdown: without it a match
 * inside a list or a fenced block arrives as a snippet of mostly newlines. The
 * ellipses say the text continues, so a reader does not take a fragment for the
 * whole message.
 */
function snippetAt(body: string, at: number, length: number): string {
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(body.length, at + length + SNIPPET_RADIUS);
  const core = body.slice(from, to).replace(/\s+/g, ' ').trim();

  return `${from > 0 ? '…' : ''}${core}${to < body.length ? '…' : ''}`;
}

export interface ConversationRoutesOptions {
  store: ConversationStore;
  index: ChatIndex;
  /** Absent in tests that do not exercise pinning. */
  preferences?: PreferencesStore;
  /** Phase 11. Deleting a conversation releases the files it owns. */
  attachments?: AttachmentStore;
  /** Lets a reloading client rediscover the run it was watching. */
  activeGenerationId?: (userId: string, conversationId: string) => string | null;
}

/**
 * The only way a route learns who is calling (INV-14).
 *
 * `req.auth` is set by `authenticate` from the session cookie alone. A route
 * that reached here without one is a mounting bug, not a client error.
 */
function ownerOf(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

/**
 * Route params are request-controlled, so an id is validated before any use.
 * A non-canonical id is 404, not 400 — the same answer as an id that simply
 * does not exist, so probing cannot distinguish the two.
 */
function requireId(raw: unknown): string {
  if (typeof raw !== 'string' || !isCanonicalUuid(raw)) {
    throw AppError.notFound('Conversation not found.');
  }
  return raw;
}

function toDto(id: string, conversation: Conversation, activeGenerationId: string | null = null) {
  return {
    id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages,
    activeGenerationId,
  };
}

export function conversationRouter({
  store,
  index,
  preferences,
  attachments,
  activeGenerationId,
}: ConversationRoutesOptions): Router {
  const router = Router();

  /**
   * Merges in what the reader has pinned.
   *
   * Joined here rather than stored in the index, which is derived and may be
   * rebuilt from the conversation files at any time — a pin written into it
   * would vanish the first time that happened (INV-11).
   */
  async function withPins(userId: string, entries: ChatIndexEntry[]): Promise<unknown[]> {
    const pinned = (await preferences?.pinned(userId)) ?? new Set<string>();
    return entries.map((entry) => ({ ...entry, pinned: pinned.has(entry.id) }));
  }

  router.get('/conversations', async (req, res) => {
    const user = ownerOf(req);
    res.json({ conversations: await withPins(user, await index.list(user)) });
  });

  /**
   * Pins or unpins a conversation for the caller.
   *
   * A separate route from the title PATCH because it is a different kind of
   * thing: the title is the conversation's, the pin is the reader's, and they
   * are stored in different places for that reason.
   */
  router.put('/conversations/:id/pin', validateBody(pinSchema), async (req, res) => {
    const id = requireId(req.params.id);
    const { pinned } = req.body as z.infer<typeof pinSchema>;
    const user = ownerOf(req);

    if (preferences === undefined) throw AppError.internal('Pinning is not configured');
    // Refuses to pin what does not exist, so a bad id cannot leave a pin
    // pointing at nothing.
    if (!(await store.exists(user, id))) throw AppError.notFound('Conversation not found.');

    await preferences.setPinned(user, id, pinned);
    res.json({ id, pinned });
  });

  /**
   * The conversation as the file on disk, for keeping.
   *
   * Served from the stored Markdown rather than re-serialized from the parsed
   * form: what is downloaded is then exactly what the server has, byte for
   * byte, including anything a future format adds that this build would drop.
   */
  router.get('/conversations/:id/export', async (req, res) => {
    const id = requireId(req.params.id);
    const user = ownerOf(req);

    const conversation = await store.load(user, id);
    const raw = await store.raw(user, id);

    // Quotes and backslashes escaped, and a plain-ASCII fallback first: a title
    // is user-controlled text going into a header.
    const name = conversation.title.replace(/[^\w .-]+/g, '_').slice(0, 80) || 'conversation';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${name}.md"; filename*=UTF-8''${encodeURIComponent(`${conversation.title}.md`)}`
    );
    res.send(raw);
  });

  /**
   * Full-text search across the caller's own conversations.
   *
   * Registered before `/conversations/:id`, because Express matches in order
   * and `search` would otherwise be read as an id.
   *
   * The scan is done here rather than in the browser: the list the client holds
   * carries titles only, and shipping every message of every conversation to
   * search them would be both slower and a great deal more to hold in memory
   * than the handful of lines a query actually matches.
   *
   * `inspect` rather than `load`, so one unreadable file cannot fail a search
   * across all the others; a malformed conversation can still match on title,
   * which is all that is known about it.
   */
  router.get('/conversations/search', async (req, res) => {
    const user = ownerOf(req);
    const raw = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';

    // Nothing typed is not an error; it is the state the field starts in.
    if (raw === '') {
      res.json({ results: [] });
      return;
    }
    if (raw.length > SEARCH_QUERY_MAX_LENGTH) {
      throw AppError.validation('Search query is too long.');
    }

    const needle = raw.toLowerCase();
    const results: SearchResult[] = [];

    for (const entry of await index.list(user)) {
      const titleMatch = entry.title.toLowerCase().includes(needle);
      const hits: SearchHit[] = [];

      if (!entry.malformed) {
        const found = await store.inspect(user, entry.id);
        if (found.ok) {
          for (const message of found.conversation.messages) {
            // A system message is not rendered, so there is nothing to open it
            // at — offering it as a result would scroll to nowhere.
            if (message.type !== 'user' && message.type !== 'assistant') continue;

            const at = message.body.toLowerCase().indexOf(needle);
            if (at === -1) continue;

            hits.push({
              messageId: message.id,
              type: message.type,
              snippet: snippetAt(message.body, at, needle.length),
            });
            if (hits.length === HITS_PER_CONVERSATION) break;
          }
        }
      }

      if (!titleMatch && hits.length === 0) continue;
      results.push({
        id: entry.id,
        title: entry.title,
        updatedAt: entry.updatedAt,
        titleMatch,
        hits,
      });
      if (results.length === SEARCH_RESULT_LIMIT) break;
    }

    res.json({ results });
  });

  router.post('/conversations', validateBody(createSchema), async (req, res) => {
    const { title } = req.body as z.infer<typeof createSchema>;
    const user = ownerOf(req);

    const { id, conversation } = await store.create(user, title);
    await index.upsert(user, entryFor(id, conversation));

    res.status(201).json(toDto(id, conversation));
  });

  router.get('/conversations/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const user = ownerOf(req);

    res.json(toDto(id, await store.load(user, id), activeGenerationId?.(user, id) ?? null));
  });

  router.patch('/conversations/:id', validateBody(patchSchema), async (req, res) => {
    const id = requireId(req.params.id);
    const { title } = req.body as z.infer<typeof patchSchema>;
    const user = ownerOf(req);

    // A rename sets the title explicitly and disables auto-titling for this
    // conversation (contracts §3.3); `titleLocked` is tracked by the generation
    // service, which is the only thing that would otherwise auto-title.
    const updated = await store.update(user, id, (current) => ({ ...current, title }));
    await index.upsert(user, entryFor(id, updated));

    res.json(toDto(id, updated));
  });

  /**
   * Edits a message body.
   *
   * Only the body changes: ids, types, and an assistant block's recorded
   * status/provider/model describe what actually happened and are not rewritten.
   */
  router.patch(
    '/conversations/:id/messages/:messageId',
    validateBody(editMessageSchema),
    async (req, res) => {
      const id = requireId(req.params.id);
      const messageId = requireId(req.params.messageId);
      const { body } = req.body as z.infer<typeof editMessageSchema>;
      const user = ownerOf(req);

      const updated = await store.editMessageBody(user, id, messageId, body);
      await index.upsert(user, entryFor(id, updated));

      res.json(toDto(id, updated));
    }
  );

  /**
   * Deletes a message and its paired reply.
   *
   * A question and its answer are one exchange; later turns are untouched.
   */
  router.delete('/conversations/:id/messages/:messageId', async (req, res) => {
    const id = requireId(req.params.id);
    const messageId = requireId(req.params.messageId);
    const user = ownerOf(req);

    const updated = await store.deleteMessagePair(user, id, messageId);

    // Deleting the last exchange leaves nothing to come back to, so the
    // conversation goes with it rather than lingering as an empty shell. A
    // conversation that is empty because it was *just created* is untouched —
    // only a delete can trigger this. Markdown first, then the index entry, so
    // an orphaned entry is the failure mode rather than a dangling reference.
    if (updated.messages.length === 0) {
      await store.delete(user, id);
      await index.remove(user, id);
      res.status(204).end();
      return;
    }

    await index.upsert(user, entryFor(id, updated));
    res.json(toDto(id, updated));
  });

  router.delete('/conversations/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const user = ownerOf(req);

    /*
     * Which attachments this conversation owns, read before it is deleted —
     * afterwards there is nothing left to ask. A malformed conversation cannot
     * be parsed for them, and that is fine: its attachments are left behind as
     * orphans, which the sweep can collect, rather than the delete being
     * refused over a file nobody can read (INV-10).
     */
    const owned = attachments === undefined ? [] : await attachmentIdsOf(store, user, id);

    // Markdown first, then the index entry. An orphaned index entry is
    // recoverable by a rebuild; a dangling reference to a live file is not.
    await store.delete(user, id);

    /*
     * Attachments after the Markdown, and for the same reason. An attachment
     * whose conversation is already gone is an orphan — safe, and collectable.
     * A message referencing bytes that have been removed is neither
     * (contracts §7).
     */
    if (attachments !== undefined && owned.length > 0) {
      await attachments.deleteMany(user, owned);
    }
    await index.remove(user, id);
    // And the pin, which would otherwise outlive what it pointed at.
    await preferences?.forget(user, id);

    res.status(204).end();
  });

  return router;
}

/**
 * The attachment ids a conversation refers to.
 *
 * Returns nothing when the file cannot be read, rather than throwing: this is
 * only ever asked in order to clean up, and a conversation that is malformed
 * still has to be deletable.
 */
async function attachmentIdsOf(
  store: ConversationStore,
  userId: string,
  conversationId: string
): Promise<string[]> {
  try {
    const conversation = await store.load(userId, conversationId);
    return referencedIds(conversation);
  } catch {
    return [];
  }
}
