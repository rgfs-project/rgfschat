import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { StoragePaths } from '../storage/paths.ts';
import { SessionManager } from './sessions.ts';

/**
 * Revocation has to be final.
 *
 * Resolving a session slides its idle deadline forward, which means reading the
 * record and writing it back. Revoking one deletes the file. Nothing made those
 * two agree, so a revocation landing between the read and the write was undone
 * by the write: the file reappeared, carrying the same user and the same CSRF
 * token, and the session the operator had just killed went on working.
 *
 * That is the shape of every revocation in the application — logout, a password
 * change, a demotion, disabling an account (INV-17) — and one request in flight
 * is all it takes, which is the ordinary case for a browser with a stream open.
 */

const logger = createLogger({ level: 'silent', write: () => {} });

let dataDir: string;
let sessions: SessionManager;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-session-race-'));
  sessions = new SessionManager({
    paths: new StoragePaths(dataDir),
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('a session revoked while it is being used', () => {
  /**
   * Run repeatedly rather than once: the two operations are a handful of
   * awaits apart, so a single pass can miss the interleaving even when it is
   * always possible. A revocation that survives every trial is the property;
   * one resurrection in twenty is a broken logout.
   */
  it('stays revoked when logout lands during a request', async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const created = await sessions.create('u-1');

      await Promise.all([
        sessions.resolve(created.token).catch(() => null),
        sessions.destroy(created.token),
      ]);

      expect(await sessions.resolve(created.token)).toBeNull();
    }
  });

  it('stays revoked when every session for the account is revoked at once', async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const created = await sessions.create('u-1');

      await Promise.all([
        sessions.resolve(created.token).catch(() => null),
        sessions.revokeAllForUser('u-1'),
      ]);

      expect(await sessions.resolve(created.token)).toBeNull();
    }
  });

  /**
   * The revocation must also win when it is the slower of the two — a resolve
   * already past its read cannot be allowed to put the record back.
   */
  it('stays revoked when the revocation is the later of the two', async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const created = await sessions.create('u-1');

      const resolving = sessions.resolve(created.token).catch(() => null);
      await sessions.destroy(created.token);
      await resolving;

      expect(await sessions.resolve(created.token)).toBeNull();
    }
  });
});
