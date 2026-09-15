import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import { JSON_BODY_LIMIT } from './config.ts';
import type { GenerationManager } from './generation/manager.ts';
import type { Logger } from './logger.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import type { ProviderHub } from './provider/hub.ts';
import { generationRouter } from './routes/generations.ts';
import { healthRouter } from './routes/health.ts';
import { conversationRouter } from './routes/conversations.ts';
import type { PreferencesStore } from './storage/preferences.ts';
import type { ArtifactStore } from './storage/artifacts.ts';
import { artifactRoutes } from './routes/artifacts.ts';
import type { MemoryStore } from './storage/memories.ts';
import { meRouter } from './routes/me.ts';
import { authRouter } from './routes/auth.ts';
import { adminRouter } from './routes/admin.ts';
import { createAttachmentsRouter } from './routes/attachments.ts';
import { scriptHash, securityHeaders } from './middleware/securityHeaders.ts';
import { RateLimiter, rateLimit, userOf } from './middleware/rateLimit.ts';
import type { AttachmentStore } from './attachments/store.ts';
import { authenticate, requireAdmin, requireAuth, requireCsrf } from './auth/middleware.ts';
import type { ProviderRegistry } from './provider/registry.ts';
import type { SettingsStore } from './admin/settings.ts';
import type { AuditLog } from './admin/audit.ts';
import type { HostPolicy } from './provider/ssrf.ts';
import type { SessionManager } from './auth/sessions.ts';
import type { UserStore } from './auth/users.ts';
import type { AuthConfig } from './config.ts';
import type { ConversationStore } from './storage/conversations.ts';
import type { ChatIndex } from './storage/index.ts';
import type { GenerationService } from './generation/service.ts';

export interface AppOptions {
  logger: Logger;
  /** Omitted in Phase 1-style tests that only exercise health and the error contract. */
  hub?: ProviderHub;
  manager?: GenerationManager;
  /**
   * Directory of the built client. When present, the server also serves the UI,
   * which is what makes `npm start` a complete self-hosted application rather
   * than an API that needs a separate static host.
   */
  clientDir?: string;
  store?: ConversationStore;
  index?: ChatIndex;
  /** Per-reader state that belongs in neither the file nor the index. */
  preferences?: PreferencesStore;
  memories?: MemoryStore;
  artifacts?: ArtifactStore;
  service?: GenerationService;
  users?: UserStore;
  sessions?: SessionManager;
  authConfig?: AuthConfig;
  isProduction?: boolean;
  /** Phase 9. Absent in tests that do not exercise the admin surface. */
  registry?: ProviderRegistry;
  settings?: SettingsStore;
  audit?: AuditLog;
  policy?: HostPolicy;
  /** Phase 11. Absent in tests that do not exercise attachments. */
  attachments?: AttachmentStore;
}

/**
 * Builds the Express application.
 *
 * Express 5 handles rejected promises from async handlers natively, so there is
 * no async wrapper library. Order matters: body parsing, routes, 404, then the
 * single error boundary.
 */
export function createApp({
  logger,
  hub,
  manager,
  store,
  index,
  preferences,
  memories,
  artifacts,
  service,
  users,
  sessions,
  authConfig,
  clientDir,
  isProduction = false,
  registry,
  settings,
  audit,
  policy,
  attachments,
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');

  /*
   * One limiter for the whole process, shared by every rule. Separate limiters
   * would each keep their own counters and a caller would get one budget per
   * route family rather than the budget the operator configured.
   */
  const limiter = new RateLimiter();

  /*
   * Before every route, including the static client and the 404, so no
   * response can escape without them. The inline theme script in `index.html`
   * is read once and allowed by hash — see the note in the middleware.
   */
  app.use(
    securityHeaders({
      isProduction,
      inlineScriptHashes: inlineScriptHashesFor(clientDir),
    })
  );

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Health is public and must answer before anything auth-related.
  app.use('/api', healthRouter());

  if (users !== undefined && sessions !== undefined && authConfig !== undefined) {
    // Resolves the session for every request, including public ones, so
    // `GET /api/auth/session` can describe the caller.
    app.use(authenticate({ sessions, users }));
    app.use(
      '/api',
      authRouter({
        limiter,
        users,
        sessions,
        config: authConfig,
        isProduction,
        logger,
        ...(settings === undefined
          ? {}
          : {
              registrationMode: () => settings.resolved().registrationMode,
              onFirstAccountRegistered: async () => {
                await settings.save({ ...settings.stored(), registrationMode: 'closed' });
              },
            }),
      })
    );

    // Everything below this line requires a session and a CSRF token. Mounting
    // it as a gate rather than per-route means a new route cannot be added
    // unprotected by omission (INV-16, INV-24 groundwork).
    app.use('/api', requireAuth(), requireCsrf());
  }

  if (store !== undefined && index !== undefined) {
    app.use(
      '/api',
      conversationRouter({
        store,
        index,
        ...(preferences === undefined ? {} : { preferences }),
        ...(attachments === undefined ? {} : { attachments }),
        ...(service !== undefined
          ? {
              activeGenerationId: (userId: string, conversationId: string) =>
                service.activeGenerationId(userId, conversationId),
            }
          : {}),
      })
    );

    // Artifacts are a read-only projection of the same conversations, so they
    // need the same two collaborators and nothing else.
  }

  // Everything a reader can change about their own account. Mounted after the
  // auth gate above, like every other authenticated router.
  if (
    store !== undefined &&
    index !== undefined &&
    manager !== undefined &&
    preferences !== undefined &&
    memories !== undefined &&
    users !== undefined &&
    sessions !== undefined
  ) {
    app.use(
      '/api',
      meRouter({
        store,
        index,
        manager,
        preferences,
        memories,
        ...(artifacts === undefined ? {} : { artifacts }),
        users,
        sessions,
      })
    );
  }

  /*
   * Attachments depend on nothing but their own store, so they are mounted on
   * their own rather than inside the block above — a router that needs one
   * collaborator should not be switched off because a different router's
   * collaborators are missing.
   *
   * After the JSON parser and unaffected by it: the upload route reads the raw
   * request stream itself, and `express.json` ignores a multipart body. Its
   * size limit is enforced while streaming rather than by a body parser, so
   * `JSON_BODY_LIMIT` does not apply — the phase asks for a separate limit,
   * and this is how it is separate.
   */
  if (attachments !== undefined) {
    /*
     * Uploads are limited per account rather than per address: they require a
     * session, so the account is the thing that can be held responsible, and
     * limiting by address would punish everyone behind one office NAT.
     */
    app.use(
      '/api/attachments',
      rateLimit(limiter, {
        name: 'upload',
        limit: 60,
        windowMs: 60_000,
        key: (req) => (req.method === 'POST' ? userOf(req) : null),
      })
    );
    app.use('/api', createAttachmentsRouter(attachments));
  }

  if (artifacts !== undefined) {
    // Read-only from the browser's side: nothing here accepts bytes.
    app.use('/api', artifactRoutes(artifacts));
  }

  if (hub !== undefined && manager !== undefined && service !== undefined) {
    /*
     * A generation is the most expensive thing a request can ask for — it
     * occupies the provider and, on a router-mode server, can evict a resident
     * model. Limited per account, generously enough that a person never meets
     * it and a loop does.
     */
    app.use(
      '/api/generations',
      rateLimit(limiter, {
        name: 'generation-start',
        limit: 30,
        windowMs: 60_000,
        key: (req) => (req.method === 'POST' ? userOf(req) : null),
      })
    );

    app.use(
      '/api',
      generationRouter({ manager, hub, service, ...(settings === undefined ? {} : { settings }) })
    );
  }

  /*
   * Administration, behind one gate.
   *
   * `requireAdmin` is mounted on the router rather than on each route, for the
   * same reason `requireAuth` is: a route added later cannot end up unprotected
   * by someone forgetting to repeat the check (INV-24).
   */
  if (
    users !== undefined &&
    sessions !== undefined &&
    manager !== undefined &&
    index !== undefined &&
    store !== undefined &&
    hub !== undefined &&
    registry !== undefined &&
    settings !== undefined &&
    audit !== undefined &&
    policy !== undefined
  ) {
    /*
     * Scoped to the admin prefix, not to `/api`. Mounted on `/api` it would
     * also intercept anything the earlier routers did not match — so a bad
     * method on a conversation route would answer 403 to a non-admin instead
     * of the 404 it deserves.
     */
    app.use(
      '/api/admin',
      requireAdmin({ users }),
      adminRouter({
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
      })
    );
  }

  // Anything under /api that got this far is a genuine unknown route, and must
  // answer with the canonical JSON error rather than the SPA shell.
  app.use('/api', notFoundHandler());

  if (clientDir !== undefined && existsSync(join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir, { index: false }));

    // SPA fallback: a client-side route is not a 404. Only GET/HEAD, so a
    // mistyped POST still fails loudly instead of returning HTML.
    //
    // The braces matter: in Express 5, `/*splat` requires at least one path
    // segment and so never matches `/` itself.
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(join(clientDir, 'index.html'));
    });
  }

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}

/**
 * The hashes of any inline scripts the served `index.html` contains.
 *
 * Read from the built file rather than hard-coded, so editing the theme script
 * cannot leave a stale hash behind — which would fail closed, with a white
 * flash on every load and a console full of CSP violations, and would be
 * noticed late because everything else would still work.
 *
 * An unreadable or absent shell yields no hashes, which is correct: with no
 * client to serve there is no inline script to allow.
 */
function inlineScriptHashesFor(clientDir: string | undefined): string[] {
  if (clientDir === undefined) return [];

  let html: string;
  try {
    html = readFileSync(join(clientDir, 'index.html'), 'utf8');
  } catch {
    return [];
  }

  const hashes: string[] = [];
  // Inline only: a `<script src=…>` is covered by `'self'` and has no body to
  // hash. The lazy body match stops at the first closing tag.
  const inline = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(inline)) {
    const body = match[1] ?? '';
    if (body.trim() !== '') hashes.push(scriptHash(body));
  }
  return hashes;
}
