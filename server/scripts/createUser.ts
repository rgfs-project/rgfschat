import { createInterface } from 'node:readline/promises';
import { isValidPassword, isValidUsername, normalizeUsername } from '@shared/auth.ts';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { UserStore } from '../auth/users.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * Creates an account from the command line (contracts §6).
 *
 *   npm run user:create -- --username ada --admin
 *   npm run user:create -- --username ada --adopt-local-data
 *
 * The password is read from an interactive prompt or from stdin — **never from
 * argv**, where it would land in shell history and in the process list for
 * every other user on the machine.
 */

interface Options {
  username: string;
  admin: boolean;
  adoptLocalData: boolean;
}

function parseArgs(argv: string[]): Options {
  let username = '';
  let admin = false;
  let adoptLocalData = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--username' || arg === '-u') {
      username = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--admin') {
      admin = true;
    } else if (arg === '--adopt-local-data') {
      adoptLocalData = true;
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

  if (username === '')
    throw new Error(
      'Usage: npm run user:create -- --username <name> [--admin] [--adopt-local-data]'
    );
  return { username, admin, adoptLocalData };
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

  // Enable raw mode to hide password input
  const stdin = process.stdin;
  const origModeRaw = stdin.isRaw;

  async function readHiddenInput(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    stdin.setRawMode?.(true);

    let password = '';
    return new Promise((resolve) => {
      const handler = (chunk: Buffer) => {
        const char = chunk.toString();

        if (char === '\n' || char === '\r') {
          stdin.removeListener('data', handler);
          stdin.setRawMode?.(origModeRaw ?? false);
          process.stdout.write('\n');
          resolve(password);
        } else if (char === '') {
          // Ctrl+C
          process.exit(0);
        } else if (char === '') {
          // Backspace
          password = password.slice(0, -1);
        } else if (char >= ' ') {
          password += char;
        }
      };
      stdin.on('data', handler);
    });
  }

  try {
    const first = await readHiddenInput('Password: ');
    const second = await readHiddenInput('Confirm password: ');
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

  const password = (await readPipedPassword()) ?? (await promptPassword());
  if (!isValidPassword(password)) {
    throw new Error('Password must be at least 8 characters.');
  }

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const users = new UserStore({ paths: new StoragePaths(config.dataDir), logger });

  const user = await users.create({
    username,
    password,
    role: options.admin ? 'admin' : 'user',
    // Adopting means taking LOCAL_USER_ID as this account's id, so the existing
    // data/<LOCAL_USER_ID>/ directory simply becomes theirs — no files move.
    ...(options.adoptLocalData ? { id: config.localUserId } : {}),
  });

  process.stdout.write(
    `Created ${user.role} "${user.username}" (${user.id})` +
      (options.adoptLocalData ? ' — adopted existing local data\n' : '\n')
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
