import { Router, type Request } from 'express';
import { z } from 'zod';
import { TITLE_MAX_LENGTH, type Conversation } from '@shared/conversation.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import { entryFor, type ChatIndex } from '../storage/index.ts';
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

export interface ConversationRoutesOptions {
  store: ConversationStore;
  index: ChatIndex;
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
  activeGenerationId,
}: ConversationRoutesOptions): Router {
  const router = Router();

  router.get('/conversations', async (req, res) => {
    res.json({ conversations: await index.list(ownerOf(req)) });
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

    // Markdown first, then the index entry. An orphaned index entry is
    // recoverable by a rebuild; a dangling reference to a live file is not.
    await store.delete(user, id);
    await index.remove(user, id);

    res.status(204).end();
  });

  return router;
}
