import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateBody } from '../http/validate.ts';
import { AppError } from '../errors/AppError.ts';
import { clearHistoryFor } from '../conversation/clearHistory.ts';
import { MEMORY_MAX_BYTES, type MemoryStore } from '../storage/memories.ts';
import { isMemoryName, MEMORY_NAME_MAX_LENGTH } from '../storage/paths.ts';
import type { PreferencesStore } from '../storage/preferences.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { ChatIndex } from '../storage/index.ts';
import type { GenerationManager } from '../generation/manager.ts';

/**
 * What a reader can change about their own account.
 *
 * Everything here acts on the caller and nobody else — there is no `userId` to
 * send. The admin router has the routes that act on *another* account, behind
 * `requireAdmin`; these are the same capabilities scoped to oneself, so a
 * person who is not an administrator can still choose a model, clear their own
 * conversations, and manage what is remembered about them.
 */

const preferencesSchema = z.strictObject({
  /** `null` clears the choice and returns the reader to the instance default. */
  defaultModel: z
    .strictObject({ providerId: z.string().min(1).max(200), modelId: z.string().min(1).max(400) })
    .nullable(),
});

const clearSchema = z.strictObject({
  withinHours: z.union([z.literal(1), z.literal(6), z.literal(12), z.literal(24)]).optional(),
  /** Must be sent deliberately; there is no accidental path to this. */
  confirm: z.literal(true),
});

const memorySchema = z.strictObject({
  name: z.string().min(1).max(MEMORY_NAME_MAX_LENGTH),
  content: z.string().min(1).max(MEMORY_MAX_BYTES),
});

export interface MeRoutesOptions {
  store: ConversationStore;
  index: ChatIndex;
  manager: GenerationManager;
  preferences: PreferencesStore;
  memories: MemoryStore;
}

/** The caller, from the session and never from the request (INV-14). */
function caller(req: Request): string {
  const userId = req.auth?.userId;
  if (userId === undefined) throw AppError.internal('Route reached without authentication');
  return userId;
}

export function meRouter({
  store,
  index,
  manager,
  preferences,
  memories,
}: MeRoutesOptions): Router {
  const router = Router();

  router.get('/me/preferences', async (req, res) => {
    const { defaultModel } = await preferences.read(caller(req));
    res.json({ defaultModel });
  });

  router.patch('/me/preferences', validateBody(preferencesSchema), async (req, res) => {
    const { defaultModel } = req.body as z.infer<typeof preferencesSchema>;
    await preferences.setDefaultModel(caller(req), defaultModel);
    res.json({ defaultModel });
  });

  /**
   * Clears the caller's own conversations.
   *
   * The same operation the admin panel offers, without the ability to name
   * somebody else — which is the whole difference between the two routers.
   */
  router.post('/me/history/clear', validateBody(clearSchema), async (req, res) => {
    const { withinHours } = req.body as z.infer<typeof clearSchema>;
    const result = await clearHistoryFor(caller(req), { store, index, manager, withinHours });
    res.json({ ok: true, ...result });
  });

  router.get('/me/memories', async (req, res) => {
    res.json({ memories: await memories.list(caller(req)) });
  });

  router.put('/me/memories', validateBody(memorySchema), async (req, res) => {
    const { name, content } = req.body as z.infer<typeof memorySchema>;
    if (!isMemoryName(name)) {
      throw AppError.validation(
        'A memory name is lowercase letters, digits and hyphens, up to 64 characters.'
      );
    }
    res.json({ memory: await memories.write(caller(req), name, content) });
  });

  router.delete('/me/memories/:name', async (req, res) => {
    const name = typeof req.params.name === 'string' ? req.params.name : '';
    // A name that could never exist and a name that does not exist get the same
    // answer, so nothing here reports on what the filesystem holds.
    if (!(await memories.remove(caller(req), name))) {
      throw AppError.notFound('No such memory.');
    }
    res.status(204).end();
  });

  return router;
}
