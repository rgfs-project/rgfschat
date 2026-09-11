import { Router } from 'express';
import type { HealthDto } from '@shared/api.ts';
import { APP_VERSION } from '../version.ts';

/**
 * `GET /api/health` — public liveness probe.
 *
 * The DTO is built explicitly (INV-03): the response carries the app version
 * and nothing else. No environment values, paths, or dependency versions.
 */
export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const dto: HealthDto = { status: 'ok', version: APP_VERSION };
    res.json(dto);
  });

  return router;
}
