import express, { type Express } from 'express';
import { JSON_BODY_LIMIT } from './config.ts';
import type { Logger } from './logger.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { healthRouter } from './routes/health.ts';

export interface AppOptions {
  logger: Logger;
}

/**
 * Builds the Express application.
 *
 * Express 5 handles rejected promises from async handlers natively, so there is
 * no async wrapper library. Order matters: body parsing, routes, 404, then the
 * single error boundary.
 */
export function createApp({ logger }: AppOptions): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api', healthRouter());

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
