import express, { type Express } from 'express';
import { JSON_BODY_LIMIT } from './config.ts';
import type { GenerationManager } from './generation/manager.ts';
import type { Logger } from './logger.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import type { Provider } from './provider/types.ts';
import { generationRouter } from './routes/generations.ts';
import { healthRouter } from './routes/health.ts';

export interface AppOptions {
  logger: Logger;
  /** Omitted in Phase 1-style tests that only exercise health and the error contract. */
  provider?: Provider;
  manager?: GenerationManager;
}

/**
 * Builds the Express application.
 *
 * Express 5 handles rejected promises from async handlers natively, so there is
 * no async wrapper library. Order matters: body parsing, routes, 404, then the
 * single error boundary.
 */
export function createApp({ logger, provider, manager }: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api', healthRouter());

  if (provider !== undefined && manager !== undefined) {
    app.use('/api', generationRouter({ manager, provider }));
  }

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
