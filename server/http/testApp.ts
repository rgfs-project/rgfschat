import express, { type Express } from 'express';
import { z } from 'zod';
import { JSON_BODY_LIMIT } from '../config.ts';
import { createLogger } from '../logger.ts';
import { errorHandler, notFoundHandler } from '../middleware/errorHandler.ts';
import { validateBody } from './validate.ts';

/**
 * Builds an app that exercises the Phase 1 HTTP conventions on throwaway routes.
 *
 * Phase 1 ships exactly one real route (`/api/health`), but the validation,
 * DTO, and error conventions apply to every route later phases add. These
 * fixtures let the conventions themselves be tested without adding routes to
 * the production app that only exist for tests.
 */
export function createTestApp(): Express {
  const app = express();
  const logger = createLogger({ level: 'silent', write: () => {} });

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  const echoSchema = z.strictObject({
    name: z.string().min(1).max(100),
    count: z.number().int().optional(),
  });

  app.post('/test/echo', validateBody(echoSchema), (req, res) => {
    const body = req.body as z.infer<typeof echoSchema>;
    // Explicit DTO: only declared fields are echoed back.
    res.json({ name: body.name });
  });

  app.get('/test/boom', () => {
    throw new Error('Secret internal detail: /etc/passwd token=abc123');
  });

  app.get('/test/async-boom', async () => {
    await Promise.resolve();
    // Express 5 forwards rejected promises without a wrapper.
    throw new Error('Async failure with sensitive path /var/secrets/key.pem');
  });

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
