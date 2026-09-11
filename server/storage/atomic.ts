import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../logger.ts';

/**
 * Durable, atomic replacement of a file (contracts §2).
 *
 * write temp → fsync file → rename over target → fsync parent directory.
 *
 * The rename is atomic on POSIX, so a reader never observes a half-written
 * file: it sees either the old bytes or the new ones. Fsyncing the file before
 * the rename is what makes that true after a power loss rather than merely
 * after a process crash — without it the rename can land before the data.
 *
 * **Windows caveat.** Directory fsync is not available, so the final barrier is
 * skipped there (the error is swallowed deliberately). `rename` over an
 * existing file also has different semantics and can fail if the target is open
 * in another process. Contracts §2 declares single-process operation, and
 * Windows is documented as unsupported for durability guarantees.
 */

/** Permissions from contracts §1: directories 0700, files 0600. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** `.<name>.<random>.tmp` — matched exactly by the startup sweeper. */
const TEMP_SUFFIX = '.tmp';

function tempPathFor(target: string): string {
  const name = basename(target);
  const random = randomBytes(6).toString('hex');
  return join(dirname(target), `.${name}.${random}${TEMP_SUFFIX}`);
}

/** Only files this module could have written are ever swept. */
export function isTempName(name: string): boolean {
  return /^\..+\.[0-9a-f]{12}\.tmp$/.test(name);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
}

/**
 * Writes `data` to `target` atomically and durably.
 *
 * `onBeforeRename` exists so a test can simulate a crash between the temp write
 * and the rename, proving the original file is left intact.
 */
export async function atomicWriteFile(
  target: string,
  data: string,
  options: { onBeforeRename?: () => void | Promise<void> } = {}
): Promise<void> {
  await ensureDir(dirname(target));

  const temp = tempPathFor(target);

  const handle = await open(temp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (options.onBeforeRename !== undefined) {
    await options.onBeforeRename();
  }

  try {
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }

  // Barrier for the directory entry itself. Unavailable on Windows.
  try {
    const dir = await open(dirname(target), constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Platform does not support directory fsync; documented above.
  }
}

/** Writes a file that must not already exist, with canonical permissions. */
export async function writeNewFile(target: string, data: string): Promise<void> {
  await ensureDir(dirname(target));
  await writeFile(target, data, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes stale temp files left by a crash (contracts §2).
 *
 * Only names matching the temp pattern *and* older than process start are
 * removed, so a concurrently-running write is never destroyed and no other file
 * can be swept by accident.
 */
export async function cleanupTempFiles(
  dir: string,
  processStart: Date,
  logger: Logger
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (!isTempName(name)) continue;

    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (info.mtime >= processStart) continue;
      await unlink(full);
      removed += 1;
    } catch {
      // Vanished or unreadable; nothing to do.
    }
  }

  if (removed > 0) logger.info('Removed stale temp files', { dir, removed });
  return removed;
}
