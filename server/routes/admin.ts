import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/AppError.ts';
import { validateBody } from '../http/validate.ts';
import { toDto, type UserStore } from '../auth/users.ts';
import type { SessionManager } from '../auth/sessions.ts';
import type { GenerationManager } from '../generation/manager.ts';
import type { ChatIndex } from '../storage/index.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { ProviderRegistry, ProviderConfigEntry } from '../provider/registry.ts';
import type { ProviderHub } from '../provider/hub.ts';
import type { SettingsStore } from '../admin/settings.ts';
import type { AuditLog } from '../admin/audit.ts';
import { SsrfError, validateProviderUrl, type HostPolicy } from '../provider/ssrf.ts';

/**
 * Administrative routes, mounted at `/api/admin`.
 *
 * Every route here is mounted behind a single `requireAdmin` in `app.ts`, which
 * resolves the role from the stored record on each request (INV-24). Nothing in
 * this file re-checks authorization, because a route that has to remember to is
 * a route that will one day forget.
 *
 * Two rules shape most of what follows:
 *
 *  - **Secrets are write-only (INV-25).** No response from here ever contains
 *    an `apiKey`. The DTO carries `hasApiKey` instead, which is everything an
 *    operator needs to know and nothing an attacker can use.
 *  - **Reducing someone's access takes effect now (INV-17).** Disabling,
 *    demoting or deleting revokes every session *and* cancels anything they
 *    have running, because a generation already in flight would otherwise keep
 *    writing to conversations they no longer have access to.
 */

/** Kept in one place so the audit log has a fixed vocabulary. */
const ACTION = {
  userCreate: 'user.create',
  userSetPassword: 'user.set-password',
  userUpdate: 'user.update',
  userDelete: 'user.delete',
  providerCreate: 'provider.create',
  providerUpdate: 'provider.update',
  providerDelete: 'provider.delete',
  providerTest: 'provider.test',
  settingsUpdate: 'settings.update',
  modelsRefresh: 'models.refresh',
  samplerUpdate: 'models.sampler',
  indexRebuild: 'index.rebuild',
  clearHistory: 'history.clear',
} as const;

const roleSchema = z.enum(['user', 'admin']);
const statusSchema = z.enum(['active', 'disabled']);

const createUserSchema = z.strictObject({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(512),
  role: roleSchema.optional(),
});

const setPasswordSchema = z.strictObject({ password: z.string().min(8).max(512) });

const updateUserSchema = z
  .strictObject({ role: roleSchema.optional(), status: statusSchema.optional() })
  .refine((value) => value.role !== undefined || value.status !== undefined, 'Nothing to change.');

const deleteUserSchema = z.strictObject({ username: z.string().min(1) });

const modelPairSchema = z.strictObject({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

/**
 * `apiKey` present replaces the secret, `clearApiKey` removes it, and neither
 * keeps whatever is stored. The three cases are mutually exclusive so an edit
 * can never be ambiguous about what happens to a credential.
 */
const providerBodySchema = z
  .strictObject({
    id: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(128),
    kind: z.literal('openai-compatible'),
    baseUrl: z.string().min(1).max(2048),
    apiKey: z.string().min(1).max(4096).optional(),
    clearApiKey: z.literal(true).optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000),
    capabilities: z
      .strictObject({ vision: z.boolean().optional(), reasoning: z.boolean().optional() })
      .optional(),
    contextTokens: z.number().int().min(1).max(10_000_000).optional(),
  })
  .refine(
    (value) => value.apiKey === undefined || value.clearApiKey !== true,
    'Send either apiKey or clearApiKey, not both.'
  );

const testProviderSchema = z.strictObject({
  baseUrl: z.string().min(1).max(2048),
  apiKey: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

const settingsSchema = z.strictObject({
  registrationMode: z.enum(['open', 'closed']).optional(),
  defaultModel: modelPairSchema.nullable().optional(),
  hiddenModels: z.array(modelPairSchema).max(500).optional(),
});

const rebuildSchema = z.strictObject({ userId: z.string().min(1).optional() });

/**
 * One model's sampling. `null` on a field clears it, so the provider's own
 * default applies again — distinct from omitting the field, which leaves it
 * as it was.
 */
/**
 * Clearing chat history.
 *
 * `withinHours` deletes conversations *touched inside* that window, which is
 * what "clear the last hour" means to the person asking. Omitting it clears
 * everything. A user id narrows it to one account; without one it applies to
 * every account, which is why the route demands the window be stated
 * explicitly rather than defaulting to the most destructive reading.
 */
const clearHistorySchema = z.strictObject({
  userId: z.string().min(1).optional(),
  withinHours: z.union([z.literal(1), z.literal(6), z.literal(12), z.literal(24)]).optional(),
  /** Must be sent deliberately; there is no accidental path to this. */
  confirm: z.literal(true),
});

const samplerBodySchema = z.strictObject({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  topK: z.number().int().min(0).max(100).nullable().optional(),
  minP: z.number().min(0).max(1).nullable().optional(),
  repeatPenalty: z.number().min(1).max(2).nullable().optional(),
  systemPrompt: z.string().max(8_000).nullable().optional(),
});

export interface AdminRoutesOptions {
  users: UserStore;
  store: ConversationStore;
  sessions: SessionManager;
  manager: GenerationManager;
  index: ChatIndex;
  registry: ProviderRegistry;
  hub: ProviderHub;
  settings: SettingsStore;
  audit: AuditLog;
  policy: HostPolicy;
}

/**
 * SSRF validation, as an API error.
 *
 * `validateProviderUrl` throws `SsrfError`, which the registry handles at load
 * time by disabling the entry. Over HTTP it has to become the contract's
 * `ENDPOINT_NOT_ALLOWED`; left alone it reaches the error boundary as an
 * unknown throw and answers 500, which tells an operator nothing about why
 * their URL was refused.
 */
function assertEndpointAllowed(baseUrl: string, policy: HostPolicy): void {
  try {
    validateProviderUrl(baseUrl, policy);
  } catch (err) {
    if (err instanceof SsrfError) {
      throw new AppError('ENDPOINT_NOT_ALLOWED', err.message);
    }
    throw err;
  }
}

/** The acting administrator, for the audit trail. */
function actor(req: Request): { id: string; username: string } {
  const auth = req.auth;
  if (auth === undefined) throw AppError.internal('Admin route reached without authentication');
  return { id: auth.userId, username: auth.username };
}

/** A provider as the API may describe it: configuration minus the secret. */
function toProviderAdminDto(entry: ProviderConfigEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    baseUrl: entry.baseUrl,
    // INV-25: the presence of a key, never the key.
    hasApiKey: entry.apiKey !== undefined && entry.apiKey !== '',
    timeoutMs: entry.timeoutMs,
    capabilities: entry.capabilities,
    ...(entry.contextTokens === undefined ? {} : { contextTokens: entry.contextTokens }),
  };
}

export function adminRouter({
  users,
  store,
  sessions,
  manager,
  index,
  registry,
  hub,
  settings,
  audit,
  policy,
}: AdminRoutesOptions): Router {
  const router = Router();

  /** Revokes access and stops work in flight, in that order. */
  async function revokeAccess(userId: string): Promise<{ sessions: number; generations: number }> {
    const revoked = await sessions.revokeAllForUser(userId);
    const cancelled = manager.cancelAllForOwner(userId);
    return { sessions: revoked, generations: cancelled };
  }

  /**
   * Refuses a change that would leave the instance with no way in (INV-26).
   *
   * Counted over *active admins other than the target*, which is what makes
   * this cover demoting yourself as well as someone else — the common way an
   * operator locks themselves out.
   */
  async function assertNotLastAdmin(targetId: string, what: string): Promise<void> {
    const all = await users.list();
    const othersActive = all.filter(
      (u) => u.id !== targetId && u.role === 'admin' && u.status === 'active'
    );
    if (othersActive.length === 0) {
      throw new AppError('LAST_ADMIN', `Cannot ${what} the last active administrator.`);
    }
  }

  /* --- users ------------------------------------------------------------- */

  router.get('/users', async (_req, res) => {
    const list = await users.list();
    const withCounts = await Promise.all(
      list.map(async (user) => ({
        ...user,
        conversationCount: (await index.list(user.id).catch(() => [])).length,
      }))
    );
    res.json({ users: withCounts });
  });

  router.get('/users/:id', async (req, res) => {
    const user = await users.findById(String(req.params.id));
    if (user === null) throw AppError.notFound('Account not found.');
    res.json({
      user: {
        ...toDto(user),
        conversationCount: (await index.list(user.id).catch(() => [])).length,
      },
    });
  });

  router.post('/users', validateBody(createUserSchema), async (req, res) => {
    const { username, password, role } = req.body as z.infer<typeof createUserSchema>;
    const created = await users.create({
      username,
      password,
      ...(role === undefined ? {} : { role }),
    });

    await audit.record({
      ...actorEntry(req),
      action: ACTION.userCreate,
      target: created.id,
      outcome: 'success',
      details: { username: created.username, role: created.role },
    });
    res.status(201).json({ user: created });
  });

  router.post('/users/:id/password', validateBody(setPasswordSchema), async (req, res) => {
    const id = String(req.params.id);
    const user = await users.findById(id);
    if (user === null) throw AppError.notFound('Account not found.');

    const { password } = req.body as z.infer<typeof setPasswordSchema>;
    await users.setPassword(id, password);
    // Every existing session was established with the old credential.
    const revoked = await sessions.revokeAllForUser(id);

    await audit.record({
      ...actorEntry(req),
      action: ACTION.userSetPassword,
      target: id,
      outcome: 'success',
      details: { sessionsRevoked: revoked },
    });
    res.json({ ok: true, sessionsRevoked: revoked });
  });

  router.patch('/users/:id', validateBody(updateUserSchema), async (req, res) => {
    const id = String(req.params.id);
    const existing = await users.findById(id);
    if (existing === null) throw AppError.notFound('Account not found.');

    const changes = req.body as z.infer<typeof updateUserSchema>;
    const demoting = changes.role === 'user' && existing.role === 'admin';
    const disabling = changes.status === 'disabled' && existing.status === 'active';

    if (existing.role === 'admin' && existing.status === 'active' && (demoting || disabling)) {
      await assertNotLastAdmin(id, demoting ? 'demote' : 'disable');
    }

    const updated = await users.update(id, {
      ...(changes.role === undefined ? {} : { role: changes.role }),
      ...(changes.status === undefined ? {} : { status: changes.status }),
    });

    // Only a *reduction* revokes; promoting or re-enabling leaves sessions be.
    const effects =
      demoting || disabling ? await revokeAccess(id) : { sessions: 0, generations: 0 };

    await audit.record({
      ...actorEntry(req),
      action: ACTION.userUpdate,
      target: id,
      outcome: 'success',
      details: {
        role: updated.role,
        status: updated.status,
        sessionsRevoked: effects.sessions,
        generationsCancelled: effects.generations,
      },
    });
    res.json({ user: updated, ...effects });
  });

  router.delete('/users/:id', validateBody(deleteUserSchema), async (req, res) => {
    const id = String(req.params.id);
    const existing = await users.findById(id);
    if (existing === null) throw AppError.notFound('Account not found.');

    const { username } = req.body as z.infer<typeof deleteUserSchema>;
    // Typing the name is the confirmation; a mismatched one is a refusal, not
    // a validation error about the shape of the request.
    if (username !== existing.username) {
      throw AppError.validation('The typed username does not match.');
    }

    if (existing.role === 'admin' && existing.status === 'active') {
      await assertNotLastAdmin(id, 'delete');
    }

    const effects = await revokeAccess(id);
    await users.delete(id);

    await audit.record({
      ...actorEntry(req),
      action: ACTION.userDelete,
      target: id,
      outcome: 'success',
      details: {
        username: existing.username,
        sessionsRevoked: effects.sessions,
        generationsCancelled: effects.generations,
      },
    });
    res.json({ ok: true, ...effects });
  });

  /* --- providers --------------------------------------------------------- */

  router.get('/providers', (_req, res) => {
    res.json({ providers: hub.entries().map(toProviderAdminDto) });
  });

  router.post('/providers', validateBody(providerBodySchema), async (req, res) => {
    const body = req.body as z.infer<typeof providerBodySchema>;
    const entries = hub.entries();

    const id = body.id ?? slugFor(body.name, entries);
    if (entries.some((entry) => entry.id === id)) {
      throw new AppError('CONFLICT', 'A provider with that id already exists.');
    }

    // INV-19 on every write, not only at load.
    assertEndpointAllowed(body.baseUrl, policy);

    const entry = buildEntry(id, body, undefined);
    await persist([...entries, entry]);

    await audit.record({
      ...actorEntry(req),
      action: ACTION.providerCreate,
      target: id,
      outcome: 'success',
      details: { name: entry.name, hasApiKey: entry.apiKey !== undefined },
    });
    res.status(201).json({ provider: toProviderAdminDto(entry) });
  });

  router.patch('/providers/:id', validateBody(providerBodySchema), async (req, res) => {
    const id = String(req.params.id);
    const entries = hub.entries();
    const existing = entries.find((entry) => entry.id === id);
    if (existing === undefined) throw new AppError('PROVIDER_NOT_FOUND', 'Provider not found.');

    const body = req.body as z.infer<typeof providerBodySchema>;
    assertEndpointAllowed(body.baseUrl, policy);

    const entry = buildEntry(id, body, existing.apiKey);
    await persist(entries.map((candidate) => (candidate.id === id ? entry : candidate)));

    await audit.record({
      ...actorEntry(req),
      action: ACTION.providerUpdate,
      target: id,
      outcome: 'success',
      details: {
        name: entry.name,
        // Records *that* the credential changed, never what it became.
        apiKeyChanged: body.apiKey !== undefined || body.clearApiKey === true,
        hasApiKey: entry.apiKey !== undefined,
      },
    });
    res.json({ provider: toProviderAdminDto(entry) });
  });

  router.delete('/providers/:id', async (req, res) => {
    const id = String(req.params.id);
    const entries = hub.entries();
    if (!entries.some((entry) => entry.id === id)) {
      throw new AppError('PROVIDER_NOT_FOUND', 'Provider not found.');
    }

    await persist(entries.filter((entry) => entry.id !== id));

    await audit.record({
      ...actorEntry(req),
      action: ACTION.providerDelete,
      target: id,
      outcome: 'success',
    });
    res.json({ ok: true });
  });

  router.post('/providers/test', validateBody(testProviderSchema), async (req, res) => {
    const body = req.body as z.infer<typeof testProviderSchema>;
    // The same guarded path a real request takes, so a test cannot succeed
    // against somewhere a generation would be refused.
    assertEndpointAllowed(body.baseUrl, policy);

    const result = await hub.testEndpoint({
      baseUrl: body.baseUrl,
      ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
      timeoutMs: body.timeoutMs ?? 10_000,
    });

    await audit.record({
      ...actorEntry(req),
      action: ACTION.providerTest,
      target: body.baseUrl,
      outcome: result.ok ? 'success' : 'failure',
      details: { modelCount: result.modelCount ?? 0 },
    });
    res.json(result);
  });

  /* --- settings, models, maintenance ------------------------------------- */

  router.get('/settings', (_req, res) => {
    res.json({ settings: settings.stored(), resolved: settings.resolved() });
  });

  router.patch('/settings', validateBody(settingsSchema), async (req, res) => {
    const body = req.body as z.infer<typeof settingsSchema>;
    const current = settings.stored();

    const next = {
      ...((body.registrationMode ?? current.registrationMode)
        ? { registrationMode: body.registrationMode ?? current.registrationMode }
        : {}),
      ...(body.defaultModel === null
        ? {}
        : { defaultModel: body.defaultModel ?? current.defaultModel }),
      ...((body.hiddenModels ?? current.hiddenModels)
        ? { hiddenModels: body.hiddenModels ?? current.hiddenModels }
        : {}),
    };

    const resolved = await settings.save(next);

    await audit.record({
      ...actorEntry(req),
      action: ACTION.settingsUpdate,
      target: null,
      outcome: 'success',
      details: {
        registrationMode: resolved.registrationMode,
        hiddenModelCount: resolved.hiddenModels.length,
      },
    });
    res.json({ settings: settings.stored(), resolved });
  });

  /**
   * Replaces one model's sampling.
   *
   * A field set to `null` is removed rather than stored as zero: "no override"
   * and "override with 0" are different instructions, and temperature 0 is a
   * perfectly ordinary thing to want.
   */
  router.patch('/models/sampler', validateBody(samplerBodySchema), async (req, res) => {
    const body = req.body as z.infer<typeof samplerBodySchema>;
    const { providerId, modelId } = body;

    // Must name a real pair, for the same reason a generation must (INV-18):
    // otherwise settings accumulate for models that do not exist.
    await hub.resolveModel(providerId, modelId);

    const current = settings.stored().samplers ?? [];
    const existing = current.find(
      (entry) => entry.providerId === providerId && entry.modelId === modelId
    );

    const merged: Record<string, unknown> = { ...(existing ?? { providerId, modelId }) };
    for (const field of [
      'temperature',
      'topP',
      'topK',
      'minP',
      'repeatPenalty',
      'systemPrompt',
    ] as const) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value === null || value === '') delete merged[field];
      else merged[field] = value;
    }

    const others = current.filter(
      (entry) => !(entry.providerId === providerId && entry.modelId === modelId)
    );

    /*
     * An entry that no longer sets anything is dropped rather than kept as a
     * bare pair. Otherwise clearing every field leaves a record that says
     * nothing, and `settings.json` slowly fills with models someone once
     * opened and changed their mind about.
     */
    const setsSomething = Object.keys(merged).some(
      (field) => field !== 'providerId' && field !== 'modelId'
    );
    const samplers = setsSomething ? [...others, merged as (typeof current)[number]] : others;

    const stored = settings.stored();
    await settings.save({
      ...(stored.registrationMode === undefined
        ? {}
        : { registrationMode: stored.registrationMode }),
      ...(stored.defaultModel === undefined ? {} : { defaultModel: stored.defaultModel }),
      ...(stored.hiddenModels === undefined ? {} : { hiddenModels: stored.hiddenModels }),
      samplers,
    });

    await audit.record({
      ...actorEntry(req),
      action: ACTION.samplerUpdate,
      target: `${providerId}/${modelId}`,
      outcome: 'success',
      // Which knobs are set, never a system prompt's contents.
      details: { fields: Object.keys(merged).length - 2 },
    });
    res.json({ sampler: merged });
  });

  router.post('/models/refresh', async (req, res) => {
    await hub.refresh();
    const providers = await hub.listProviders();

    await audit.record({
      ...actorEntry(req),
      action: ACTION.modelsRefresh,
      target: null,
      outcome: 'success',
      details: { providerCount: providers.length },
    });
    res.json({ providers });
  });

  router.post('/maintenance/clear-history', validateBody(clearHistorySchema), async (req, res) => {
    const { userId, withinHours } = req.body as z.infer<typeof clearHistorySchema>;

    const targets = userId === undefined ? (await users.list()).map((u) => u.id) : [userId];
    const cutoff = withinHours === undefined ? null : Date.now() - withinHours * 60 * 60 * 1000;

    let deleted = 0;
    let cancelled = 0;

    for (const id of targets) {
      /*
       * Anything running belongs to a conversation inside the window by
       * definition — it is being written to right now — so it is stopped
       * before the files go, rather than left writing into a deleted
       * conversation (INV-17).
       */
      cancelled += manager.cancelAllForOwner(id);

      const entries = await index.list(id).catch(() => []);
      for (const entry of entries) {
        if (cutoff !== null) {
          const touched = Date.parse(entry.updatedAt);
          // An unparseable timestamp is left alone: a window is a claim about
          // when something happened, and we cannot make that claim here.
          if (!Number.isFinite(touched) || touched < cutoff) continue;
        }

        await store.delete(id, entry.id);
        await index.remove(id, entry.id);
        deleted += 1;
      }
    }

    await audit.record({
      ...actorEntry(req),
      action: ACTION.clearHistory,
      target: userId ?? null,
      outcome: 'success',
      details: {
        scope: userId === undefined ? 'all users' : 'one user',
        window: withinHours === undefined ? 'everything' : `${withinHours}h`,
        conversationsDeleted: deleted,
        generationsCancelled: cancelled,
      },
    });
    res.json({ ok: true, deleted, cancelled });
  });

  router.post('/maintenance/rebuild-index', validateBody(rebuildSchema), async (req, res) => {
    const { userId } = req.body as z.infer<typeof rebuildSchema>;

    const targets = userId === undefined ? (await users.list()).map((u) => u.id) : [userId];
    let rebuilt = 0;
    for (const id of targets) {
      await index.rebuild(id);
      rebuilt += 1;
    }

    await audit.record({
      ...actorEntry(req),
      action: ACTION.indexRebuild,
      target: userId ?? null,
      outcome: 'success',
      details: { users: rebuilt },
    });
    res.json({ ok: true, users: rebuilt });
  });

  /** Writes the file, then swaps the live registry in-process — no restart. */
  async function persist(entries: ProviderConfigEntry[]): Promise<void> {
    await registry.save(entries);
    hub.setProviders(entries);
  }

  return router;
}

/** The audit fields every entry shares. */
function actorEntry(req: Request): { actorId: string; actorUsername: string } {
  const who = actor(req);
  return { actorId: who.id, actorUsername: who.username };
}

/**
 * Merges a request body onto a stored entry, resolving the credential.
 *
 * `previous` is the stored key: it is carried forward when the body says
 * nothing, replaced when it sends one, and dropped when it asks to clear.
 */
function buildEntry(
  id: string,
  body: {
    name: string;
    kind: 'openai-compatible';
    baseUrl: string;
    id?: string | undefined;
    apiKey?: string | undefined;
    clearApiKey?: true | undefined;
    timeoutMs: number;
    capabilities?: { vision?: boolean | undefined; reasoning?: boolean | undefined } | undefined;
    contextTokens?: number | undefined;
  },
  previous: string | undefined
): ProviderConfigEntry {
  const apiKey = body.clearApiKey === true ? undefined : (body.apiKey ?? previous);

  return {
    id,
    name: body.name,
    kind: body.kind,
    baseUrl: body.baseUrl,
    timeoutMs: body.timeoutMs,
    capabilities: body.capabilities ?? {},
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(body.contextTokens === undefined ? {} : { contextTokens: body.contextTokens }),
  };
}

/** A stable id from a display name, unique among the existing entries. */
function slugFor(name: string, entries: ProviderConfigEntry[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'provider';

  if (!entries.some((entry) => entry.id === base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!entries.some((entry) => entry.id === candidate)) return candidate;
  }
}
