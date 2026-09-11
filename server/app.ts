import { existsSync } from 'node:fs';
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
import { authRouter } from './routes/auth.ts';
import { authenticate, requireAuth, requireCsrf } from './auth/middleware.ts';
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
  service?: GenerationService;
  users?: UserStore;
  sessions?: SessionManager;
  authConfig?: AuthConfig;
  isProduction?: boolean;
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
  service,
  users,
  sessions,
  authConfig,
  clientDir,
  isProduction = false,
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Health is public and must answer before anything auth-related.
  app.use('/api', healthRouter());

  if (users !== undefined && sessions !== undefined && authConfig !== undefined) {
    // Resolves the session for every request, including public ones, so
    // `GET /api/auth/session` can describe the caller.
    app.use(authenticate({ sessions, users }));
    app.use('/api', authRouter({ users, sessions, config: authConfig, isProduction, logger }));

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
        ...(service !== undefined
          ? {
              activeGenerationId: (userId: string, conversationId: string) =>
                service.activeGenerationId(userId, conversationId),
            }
          : {}),
      })
    );
  }

  if (hub !== undefined && manager !== undefined && service !== undefined) {
    app.use('/api', generationRouter({ manager, hub, service }));
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
