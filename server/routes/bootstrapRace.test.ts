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
 * Claiming a fresh instance can happen once.
 *
 * Registration is closed by default, with one exception: while no account
 * exists at all, the first person to register becomes the administrator and the
 * exception closes behind them. The whole value of that is the "one" — it is
 * how an instance nobody has claimed yet gets an owner without a CLI, and it is
 * supposed to be a door that admits a single person.
 *
 * Asking whether any account exists and then creating one are two steps, and
 * nothing held them together: several requests arriving at once all saw an
 * empty registry, and all of them were made administrators. On an instance
 * reachable from the internet during setup, that is the whole instance.
 */

const logger = createLogger({ level: 'silent', write: () => {} });

let dataDir: string;
let users: UserStore;

function boot(): Express {
  const paths = new StoragePaths(dataDir);
  users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
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
  });
}

function register(app: Express, username: string): request.Test {
  return request(app)
    .post('/api/auth/register')
    .send({ username, password: 'a-sufficiently-long-passphrase' });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-bootstrap-race-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('several people registering on a fresh instance at once', () => {
  it('admits exactly one, and makes exactly one administrator', async () => {
    const app = boot();

    const responses = await Promise.all([
      register(app, 'alice'),
      register(app, 'bob'),
      register(app, 'carol'),
    ]);

    const created = responses.filter((res) => res.status === 201);
    const refused = responses.filter((res) => res.status === 403);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(2);
    expect(created[0]?.body.user.role).toBe('admin');

    // And the registry agrees: one account, not three.
    expect(await users.count()).toBe(1);
    const admins = (await users.list()).filter((account) => account.role === 'admin');
    expect(admins).toHaveLength(1);
  });

  it('leaves the door shut for everyone who arrives afterwards', async () => {
    const app = boot();

    expect((await register(app, 'alice')).status).toBe(201);

    const later = await Promise.all([register(app, 'bob'), register(app, 'carol')]);
    for (const res of later) expect(res.status).toBe(403);
    expect(await users.count()).toBe(1);
  });
});
