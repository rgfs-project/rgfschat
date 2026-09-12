import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateBody } from '../http/validate.ts';
import { AppError } from '../errors/AppError.ts';
import { clearHistoryFor } from '../conversation/clearHistory.ts';
import { convertConversation, memoryNameFrom, readExport } from '../conversation/importExport.ts';
import { MEMORY_MAX_BYTES, type MemoryStore } from '../storage/memories.ts';
import { isMemoryName, MEMORY_NAME_MAX_LENGTH } from '../storage/paths.ts';
import type { PreferencesStore } from '../storage/preferences.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { ChatIndex } from '../storage/index.ts';
import type { GenerationManager } from '../generation/manager.ts';
import type { UserStore } from '../auth/users.ts';
import type { SessionManager } from '../auth/sessions.ts';

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
  /**
   * Optional: a memory is usually one sentence, and making somebody name it
   * before they can write it down is a tax on the feature. Absent, a name is
   * derived from what they wrote.
   */
  name: z.string().min(1).max(MEMORY_NAME_MAX_LENGTH).optional(),
  content: z.string().min(1).max(MEMORY_MAX_BYTES),
});

const accountSchema = z
  .strictObject({
    username: z.string().min(1).max(64).optional(),
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024).optional(),
  })
  .refine((body) => body.username !== undefined || body.newPassword !== undefined, {
    message: 'Nothing to change.',
  });

export interface MeRoutesOptions {
  store: ConversationStore;
  index: ChatIndex;
  manager: GenerationManager;
  preferences: PreferencesStore;
  memories: MemoryStore;
  users: UserStore;
  sessions: SessionManager;
}

/**
 * A name for a memory nobody named.
 *
 * The first few words, which is enough to tell two memories apart in a
 * directory listing — and a numeric suffix when it is not, rather than
 * silently replacing a note that happened to start the same way.
 */
async function nameFor(memories: MemoryStore, userId: string, content: string): Promise<string> {
  const base =
    content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 8)
      .join('-')
      .slice(0, MEMORY_NAME_MAX_LENGTH - 3)
      .replace(/-+$/, '') || 'memory';

  const taken = new Set((await memories.list(userId)).map((memory) => memory.name));
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/** The upload, with a ceiling: an export is JSON and text, not a disk image. */
const IMPORT_MAX_BYTES = 64 * 1024 * 1024;

async function readBody(req: Request): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > IMPORT_MAX_BYTES) throw AppError.validation('That file is too large to import.');
    chunks.push(buffer);
  }

  return new Uint8Array(Buffer.concat(chunks));
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
  users,
  sessions,
}: MeRoutesOptions): Router {
  const router = Router();

  /**
   * Username and password, changed together behind the current password.
   *
   * One route because they are one form: a person changing their name should
   * not have to prove who they are twice, and proving it once for a rename is
   * not optional — a session cookie is not a fresh assertion of identity.
   */
  router.patch('/me/account', validateBody(accountSchema), async (req, res) => {
    const { username, currentPassword, newPassword } = req.body as z.infer<typeof accountSchema>;
    const auth = req.auth;
    if (auth === undefined) throw AppError.internal('Route reached without authentication');

    if ((await users.verify(auth.username, currentPassword)) === null) {
      throw new AppError('UNAUTHENTICATED', 'Your current password is incorrect.');
    }

    if ((await users.findById(auth.userId)) === null) throw AppError.notFound('Account not found.');

    if (username !== undefined) await users.rename(auth.userId, username);
    if (newPassword !== undefined) {
      await users.setPassword(auth.userId, newPassword);
      // Every other session goes: a password change must evict whoever was
      // using the old one (contracts §6).
      await sessions.revokeAllForUser(auth.userId, { except: auth.token });
    }

    const updated = await users.findById(auth.userId);
    if (updated === null) throw AppError.internal('Account vanished mid-update');
    // The record carries a password hash; only the public shape leaves here.
    res.json({
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role,
        status: updated.status,
        createdAt: updated.createdAt,
      },
    });
  });

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

  /**
   * Imports a Claude export: the zip, one of its members, or the bare JSON.
   *
   * The bytes arrive as the body rather than as a form upload — one file, no
   * other fields — and are examined rather than trusted by filename. Nothing
   * existing is overwritten: a conversation whose id is already here is
   * counted and left alone, so uploading the same export twice imports it
   * once.
   */
  router.post('/me/import', async (req, res) => {
    const userId = caller(req);
    const bytes = await readBody(req);
    if (bytes.length === 0) throw AppError.validation('Nothing was uploaded.');

    const found = readExport(bytes);
    if (found.conversations.length === 0 && found.memories.length === 0) {
      throw AppError.validation(
        'That file holds no conversations or memories. Upload the export zip, or the conversations.json inside it.'
      );
    }

    const report = {
      imported: 0,
      skippedExisting: 0,
      skippedEmpty: 0,
      memories: 0,
      toolBlocks: 0,
      attachments: 0,
    };

    for (const source of found.conversations) {
      const { id, conversation, dropped } = convertConversation(source);
      report.toolBlocks += dropped.toolBlocks;
      report.attachments += dropped.attachments;

      if (conversation.messages.length === 0) {
        report.skippedEmpty += 1;
        continue;
      }
      if (await store.exists(userId, id)) {
        report.skippedExisting += 1;
        continue;
      }

      await store.writeImported(userId, id, conversation);
      report.imported += 1;
    }

    for (const memory of found.memories) {
      await memories.write(
        userId,
        memoryNameFrom(memory.path, MEMORY_NAME_MAX_LENGTH),
        memory.content
      );
      report.memories += 1;
    }

    if (report.imported > 0) await index.rebuild(userId);
    res.json(report);
  });

  router.get('/me/memories', async (req, res) => {
    res.json({ memories: await memories.list(caller(req)) });
  });

  router.put('/me/memories', validateBody(memorySchema), async (req, res) => {
    const { name, content } = req.body as z.infer<typeof memorySchema>;
    const userId = caller(req);

    const resolved = name ?? (await nameFor(memories, userId, content));
    if (!isMemoryName(resolved)) {
      throw AppError.validation(
        'A memory name is lowercase letters, digits and hyphens, up to 64 characters.'
      );
    }
    res.json({ memory: await memories.write(userId, resolved, content) });
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
