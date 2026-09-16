import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * Whose address a per-address limit is counting.
 *
 * The limits on login and registration exist to stop one host working through
 * a list of accounts. Behind a reverse proxy — which is how this is ordinarily
 * deployed — every request arrives from the proxy, so without being told
 * otherwise the server counts the whole internet as one caller: the budget
 * becomes global and the first person to trip it locks out everybody else.
 *
 * The fix cannot be `trust proxy: true`, which believes the entire
 * `X-Forwarded-For` chain and so lets a caller nominate their own address and
 * escape the limit altogether — strictly worse than not trusting it. It is a
 * hop count the operator states, and what is asserted here is both halves of
 * that: counted together when nothing is trusted, counted apart when one hop
 * is, and never taken from a header the operator has not vouched for.
 */

const logger = createLogger({ level: 'silent', write: () => {} });

let dataDir: string;

/** Just enough application to reach the auth routes and their limits. */
function boot(trustProxyHops: number): Express {
  const paths = new StoragePaths(dataDir);
  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  return createApp({
    logger,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    ...(trustProxyHops > 0 ? { trustProxyHops } : {}),
  });
}

/**
 * One failed login, from a claimed address.
 *
 * Every call uses a fresh username so that only the per-address budget
 * accumulates — the per-username limit is a different counter, and tripping it
 * would prove nothing about addresses.
 */
let attempt = 0;
function login(app: Express, forwardedFor: string): request.Test {
  attempt += 1;
  return request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', forwardedFor)
    .send({ username: `nobody${attempt}`, password: 'not-the-right-password' });
}

/** The per-address budget for login, from `routes/auth.ts`. */
const LOGIN_PER_ADDRESS = 20;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-trustproxy-'));
  attempt = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('with no proxy configured (the default)', () => {
  it('ignores X-Forwarded-For and counts every caller as one', async () => {
    const app = boot(0);

    for (let i = 0; i < LOGIN_PER_ADDRESS; i += 1) {
      expect((await login(app, '203.0.113.1')).status).toBe(401);
    }

    // A different claimed address, and the budget is already spent: the header
    // was never read, so both are the same socket peer.
    expect((await login(app, '198.51.100.9')).status).toBe(429);
  });
});

describe('with one proxy hop trusted', () => {
  it('counts the two claimed addresses separately', async () => {
    const app = boot(1);

    for (let i = 0; i < LOGIN_PER_ADDRESS; i += 1) {
      expect((await login(app, '203.0.113.1')).status).toBe(401);
    }
    expect((await login(app, '203.0.113.1')).status).toBe(429);

    // The one that matters: the exhausted budget belongs to that address alone,
    // so everybody else is still able to sign in.
    expect((await login(app, '198.51.100.9')).status).toBe(401);
  });

  /**
   * The forgery case, and the reason this is a count rather than a boolean.
   *
   * A caller who writes their own `X-Forwarded-For` prepends to it; the proxy
   * appends the address it actually saw. Trusting one hop reads the last entry
   * and skips past whatever was invented in front of it. Under
   * `trust proxy: true` the leftmost entry wins instead, which would let the
   * caller below spend somebody else's budget — and, by picking a new name
   * each time, escape their own.
   */
  it('reads past a forged entry to the address the proxy appended', async () => {
    const app = boot(1);

    for (let i = 0; i < LOGIN_PER_ADDRESS; i += 1) {
      expect((await login(app, '203.0.113.1')).status).toBe(401);
    }
    expect((await login(app, '203.0.113.1')).status).toBe(429);

    // Claiming to have come through the exhausted address changes nothing: the
    // proxy's own entry is the last one, and it is a caller with budget left.
    expect((await login(app, '203.0.113.1, 198.51.100.9')).status).toBe(401);
  });
});
