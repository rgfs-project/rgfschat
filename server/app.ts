import express, { type Express } from 'express';
import { JSON_BODY_LIMIT } from './config.ts';
import type { GenerationManager } from './generation/manager.ts';
import type { Logger } from './logger.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import type { Provider } from './provider/types.ts';
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
  provider?: Provider;
  manager?: GenerationManager;
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
  provider,
  manager,
  store,
  index,
  service,
  users,
  sessions,
  authConfig,
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
    app.use('/api', conversationRouter({ store, index }));
  }

  if (provider !== undefined && manager !== undefined && service !== undefined) {
    app.use('/api', generationRouter({ manager, provider, service }));
  }

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
