import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * The password reset, as it is actually shipped.
 *
 * `npm run user:password` runs the TypeScript source through `tsx`, and neither
 * is in the production image — no dev dependencies, no `.ts` files. So the
 * command existed exactly where it was never needed and was missing from the
 * one environment that has no other way out: an operator who has forgotten the
 * only administrator's password has no admin session to reset it from.
 *
 * Everything below therefore runs the *bundled* build with a plain `node`, and
 * through the image's entrypoint, rather than through `tsx`. It is the
 * packaging that regressed, so it is the packaging that is asserted.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(root, 'dist/server/scripts/setPassword.js');
const logger = createLogger({ level: 'error', write: () => undefined });

const OLD_PASSWORD = 'the-old-password';
const NEW_PASSWORD = 'the-new-password';

let dataDir: string;
let users: UserStore;
let sessions: SessionManager;
let userId: string;

beforeAll(() => {
  // The real build script, so a missing entry point fails here rather than in
  // a container three weeks from now.
  const built = spawnSync('node', ['scripts/build-server.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(built.status, built.stderr).toBe(0);
}, 120_000);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'set-password-'));
  const paths = new StoragePaths(dataDir);

  users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  const account = await users.create({ username: 'ada', password: OLD_PASSWORD });
  userId = account.id;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the shipped command the way the image does: plain node, stdin only. */
function run(args: string[], input = `${NEW_PASSWORD}\n`, command = ['node', bundle]): Run {
  const [bin, ...rest] = command;
  const result = spawnSync(bin as string, [...rest, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: 'error', NODE_ENV: 'production' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('the bundled command', () => {
  it('is emitted by the build, next to the admin CLI', async () => {
    expect((await stat(bundle)).isFile()).toBe(true);
    expect((await stat(join(root, 'dist/server/scripts/createUser.js'))).isFile()).toBe(true);
  });

  /* The whole point: no tsx, no TypeScript source, no dev dependencies. */
  it('carries no TypeScript import of its own', async () => {
    const code = await readFile(bundle, 'utf8');
    expect(code).not.toMatch(/from '[^']*\.ts'/);
    expect(code).not.toContain('tsx');
  });

  it('resets the password when it is fed on stdin', async () => {
    const result = run(['--username', 'ada']);

    expect(result.status, result.stderr).toBe(0);
    expect(await users.verify('ada', NEW_PASSWORD)).not.toBeNull();
    expect(await users.verify('ada', OLD_PASSWORD)).toBeNull();
  });

  it('revokes existing sessions by default', async () => {
    const session = await sessions.create(userId);

    const result = run(['--username', 'ada']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('session(s) revoked');
    expect(await sessions.resolve(session.token)).toBeNull();
  });

  it('keeps them with --keep-sessions, for a self-service change', async () => {
    const session = await sessions.create(userId);

    const result = run(['--username', 'ada', '--keep-sessions']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('sessions kept');
    expect(await sessions.resolve(session.token)).not.toBeNull();
  });

  /*
   * An argument is visible in shell history, in `ps`, and in `docker inspect`.
   * Refused rather than ignored, so nobody walks away believing it worked.
   */
  it('refuses a password passed as an argument', async () => {
    for (const args of [
      ['--username', 'ada', '--password', NEW_PASSWORD],
      ['--username', 'ada', `--password=${NEW_PASSWORD}`],
    ]) {
      const result = run(args, '');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--password is not supported');
      expect(await users.verify('ada', NEW_PASSWORD)).toBeNull();
    }
    expect(await users.verify('ada', OLD_PASSWORD)).not.toBeNull();
  });

  it('refuses a password that is too short, leaving the old one', async () => {
    const result = run(['--username', 'ada'], 'short\n');

    expect(result.status).toBe(1);
    expect(await users.verify('ada', OLD_PASSWORD)).not.toBeNull();
  });

  it('says so for an account that does not exist', () => {
    const result = run(['--username', 'nobody']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No such account');
  });

  it('needs a username', () => {
    const result = run([], '');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--username');
  });
});

/*
 * The image's own door. `npm run user:password` is not available inside the
 * container, so an operator reaches this through the entrypoint verb — and a
 * bundled script nothing dispatches to is still a missing command.
 */
describe('the image entrypoint', () => {
  const entrypoint = ['sh', join(root, 'docker-entrypoint.sh')];

  it('dispatches reset-password to the bundled command', async () => {
    const session = await sessions.create(userId);

    const result = run(['reset-password', '--username', 'ada'], `${NEW_PASSWORD}\n`, entrypoint);

    expect(result.status, result.stderr).toBe(0);
    expect(await users.verify('ada', NEW_PASSWORD)).not.toBeNull();
    expect(await sessions.resolve(session.token)).toBeNull();
  });

  it('passes --keep-sessions through', async () => {
    const session = await sessions.create(userId);

    const result = run(
      ['reset-password', '--username', 'ada', '--keep-sessions'],
      `${NEW_PASSWORD}\n`,
      entrypoint
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await sessions.resolve(session.token)).not.toBeNull();
  });

  it('still dispatches create-admin, and still defaults to serving', async () => {
    const script = await readFile(join(root, 'docker-entrypoint.sh'), 'utf8');

    expect(script).toContain('dist/server/scripts/createUser.js');
    expect(script).toContain('dist/server/index.js');
  });
});
