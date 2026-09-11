import express, { type Express } from 'express';
import { JSON_BODY_LIMIT } from './config.ts';
import type { GenerationManager } from './generation/manager.ts';
import type { Logger } from './logger.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import type { Provider } from './provider/types.ts';
import { generationRouter } from './routes/generations.ts';
import { healthRouter } from './routes/health.ts';
import { conversationRouter } from './routes/conversations.ts';
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
  /**
   * Server-side identity. In Phase 3 this is `LOCAL_USER_ID`; from Phase 4 it
   * comes from the session. It is never read from the request (INV-14).
   */
  userId?: () => string;
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
  userId,
}: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api', healthRouter());

  if (store !== undefined && index !== undefined && userId !== undefined) {
    app.use('/api', conversationRouter({ store, index, userId }));
  }

  if (
    provider !== undefined &&
    manager !== undefined &&
    service !== undefined &&
    userId !== undefined
  ) {
    app.use('/api', generationRouter({ manager, provider, service, userId }));
  }

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
