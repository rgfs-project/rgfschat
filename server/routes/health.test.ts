import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { APP_VERSION } from '../version.ts';

function app() {
  return createApp({ logger: createLogger({ level: 'silent', write: () => {} }) });
}

describe('GET /api/health', () => {
  it('returns 200 with the health DTO', async () => {
    const response = await request(app()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', version: APP_VERSION });
  });

  it('INV-03: exposes no environment values, paths, or dependency versions', async () => {
    const response = await request(app()).get('/api/health');

    // The DTO is exactly two keys — nothing can ride along.
    expect(Object.keys(response.body).sort()).toEqual(['status', 'version']);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain(process.version);
    expect(serialized).not.toMatch(/node_modules|DATA_DIR|\/home\//);
  });

  it('does not advertise the server framework', async () => {
    const response = await request(app()).get('/api/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('reports the version declared in package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(APP_VERSION).toBe(pkg.version);
  });
});
