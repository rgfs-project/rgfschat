import { createInterface } from 'node:readline/promises';
import { isValidPassword, isValidUsername, normalizeUsername } from '@shared/auth.ts';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { UserStore } from '../auth/users.ts';
import { SessionManager } from '../auth/sessions.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * Resets an account's password from the command line.
 *
 *   npm run user:password -- --username ada
 *
 * The companion to `user:create`, and the way out of the one hole this
 * application otherwise has no floor under: an operator who has forgotten the
 * only administrator's password. Every other reset path needs an admin session
 * to start from — the admin panel, and `POST /admin/users/:id/password` behind
 * it — so losing that one account meant editing JSON under `data/` by hand.
 *
 * The password is read from a prompt or from stdin and **never from argv**, for
 * the reason `createUser.ts` gives: an argument is visible in shell history and
 * in the process list to every other user on the machine.
 */

interface Options {
  username: string;
  /** Leave existing sessions alone. Off by default; see `main`. */
  keepSessions: boolean;
}

function parseArgs(argv: string[]): Options {
  let username = '';
  let keepSessions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username' || arg === '-u') {
      username = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--keep-sessions') {
      keepSessions = true;
    } else if (arg === '--password' || arg?.startsWith('--password=')) {
      // Refused on purpose rather than ignored, so nobody believes it worked.
      throw new Error(
        '--password is not supported. The password is read from a prompt or stdin so it ' +
          'cannot leak through shell history or the process list.'
      );
    } else if (arg !== undefined && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (username === '') {
    throw new Error('Usage: npm run user:password -- --username <name> [--keep-sessions]');
  }
  return { username, keepSessions };
}

/** Reads the whole of stdin when it is piped, else returns null. */
async function readPipedPassword(): Promise<string | null> {
  if (process.stdin.isTTY === true) return null;

  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(new Uint8Array(Buffer.from(chunk as Uint8Array)));
  }
  const value = Buffer.concat(chunks).toString('utf8');
  // A trailing newline from `echo` is not part of the password.
  return value.replace(/\r?\n$/, '');
}

async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const first = await rl.question('New password: ');
    const second = await rl.question('Confirm password: ');
    if (first !== second) throw new Error('Passwords did not match.');
    return first;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const username = normalizeUsername(options.username);
  if (!isValidUsername(username)) {
    throw new Error('Username must be 3-32 characters of a-z, 0-9, _, . or -');
  }

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const paths = new StoragePaths(config.dataDir);
  const users = new UserStore({ paths, logger });

  const user = await users.findByUsername(username);
  if (user === null) throw new Error(`No such account: "${username}"`);

  const password = (await readPipedPassword()) ?? (await promptPassword());
  if (!isValidPassword(password)) {
    throw new Error('Password must be at least 8 characters.');
  }

  await users.setPassword(user.id, password);

  /*
   * Sessions are revoked by default, matching the admin route.
   *
   * A reset is usually done because the old password is suspect, and a session
   * cookie outlives it — so leaving them alone would mean changing the lock
   * while whoever held the old key is still inside. `--keep-sessions` is there
   * for the other case, an operator changing their own password on a machine
   * they are already signed in on and would rather not be logged out of.
   */
  let revoked = 0;
  if (!options.keepSessions) {
    const sessions = new SessionManager({
      paths,
      logger,
      absoluteTtlMs: config.auth.absoluteTtlMs,
      idleTtlMs: config.auth.idleTtlMs,
    });
    revoked = await sessions.revokeAllForUser(user.id);
  }

  process.stdout.write(
    `Password updated for "${user.username}" (${user.id})` +
      (options.keepSessions ? ' — sessions kept\n' : ` — ${revoked} session(s) revoked\n`)
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
