import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { atomicWriteFile, ensureDir } from '../storage/atomic.ts';
import { KeyedLock } from '../storage/locks.ts';
import type { StoragePaths } from '../storage/paths.ts';

/**
 * Server-side sessions (contracts §6).
 *
 * Only the SHA-256 of the token is stored, so a stolen `_system/sessions/`
 * directory does not yield usable tokens — the same reason passwords are
 * hashed. The token itself exists only in the cookie.
 *
 * Sessions are disposable state: losing the directory logs everyone out but
 * costs no conversation data.
 */

interface SessionRecord {
  userId: string;
  csrfToken: string;
  createdAt: string;
  /** Absolute deadline; never extended. */
  expiresAt: string;
  /** Sliding deadline, refreshed on use. */
  idleExpiresAt: string;
}

const recordSchema = z.strictObject({
  userId: z.string(),
  csrfToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  idleExpiresAt: z.string(),
});

export const SESSION_COOKIE = 'workspace_session';

/** 256 bits, per contracts §6. */
const TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison for the CSRF token, which is attacker-supplied. */
export function safeEqual(a: string, b: string): boolean {
  const left = new Uint8Array(Buffer.from(a, 'utf8'));
  const right = new Uint8Array(Buffer.from(b, 'utf8'));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface SessionManagerOptions {
  paths: StoragePaths;
  logger: Logger;
  absoluteTtlMs: number;
  idleTtlMs: number;
  now?: () => Date;
}

export interface ActiveSession {
  token: string;
  userId: string;
  csrfToken: string;
}

export class SessionManager {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #absoluteTtlMs: number;
  readonly #idleTtlMs: number;
  readonly #now: () => Date;
  /**
   * One lock per session file.
   *
   * Resolving slides the idle deadline, which is a read followed by a write;
   * revoking is a delete. Without this, a revocation landing between that read
   * and that write was simply overwritten — the file came back, with the same
   * user and the same CSRF token, and a session that had been revoked went on
   * authenticating. Every path that touches a session file takes this lock, so
   * the two can no longer interleave, and a revocation that arrives after a
   * refresh has begun is applied to the refreshed record rather than lost
   * under it (INV-17).
   */
  readonly #locks = new KeyedLock();

  constructor(options: SessionManagerOptions) {
    this.#paths = options.paths;
    this.#logger = options.logger;
    this.#absoluteTtlMs = options.absoluteTtlMs;
    this.#idleTtlMs = options.idleTtlMs;
    this.#now = options.now ?? (() => new Date());
  }

  #dir(): string {
    return join(this.#paths.systemDir(), 'sessions');
  }

  /** The filename is the token *hash*, so a directory listing reveals nothing usable. */
  #file(tokenHash: string): string {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      throw new Error('session lookup requires a sha256 hex digest');
    }
    return join(this.#dir(), `${tokenHash}.json`);
  }

  async create(userId: string): Promise<ActiveSession> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const csrfToken = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.#now();

    const record: SessionRecord = {
      userId,
      csrfToken,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#absoluteTtlMs).toISOString(),
      idleExpiresAt: new Date(now.getTime() + this.#idleTtlMs).toISOString(),
    };

    await ensureDir(this.#dir());
    await atomicWriteFile(this.#file(hashToken(token)), `${JSON.stringify(record, null, 2)}\n`);

    return { token, userId, csrfToken };
  }

  async #read(tokenHash: string): Promise<SessionRecord | null> {
    try {
      const parsed = recordSchema.safeParse(
        JSON.parse(await readFile(this.#file(tokenHash), 'utf8'))
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a token to a session, refreshing its idle deadline.
   *
   * An expired session is deleted rather than merely rejected, so the directory
   * does not accumulate dead files.
   */
  async resolve(token: string): Promise<ActiveSession | null> {
    const tokenHash = hashToken(token);

    return this.#locks.run(tokenHash, async () => {
      const record = await this.#read(tokenHash);
      if (record === null) return null;

      const now = this.#now().getTime();
      if (now >= Date.parse(record.expiresAt) || now >= Date.parse(record.idleExpiresAt)) {
        await this.#unlink(tokenHash);
        return null;
      }

      // Slide the idle window forward. The absolute deadline is never extended.
      const refreshed: SessionRecord = {
        ...record,
        idleExpiresAt: new Date(now + this.#idleTtlMs).toISOString(),
      };
      await atomicWriteFile(this.#file(tokenHash), `${JSON.stringify(refreshed, null, 2)}\n`);

      return { token, userId: record.userId, csrfToken: record.csrfToken };
    });
  }

  async destroy(token: string): Promise<void> {
    await this.#destroyByHash(hashToken(token));
  }

  /** Deletes a session under its lock, so no refresh can write it back. */
  async #destroyByHash(tokenHash: string): Promise<void> {
    await this.#locks.run(tokenHash, () => this.#unlink(tokenHash));
  }

  /** The delete itself. Callers must already hold the lock for this hash. */
  async #unlink(tokenHash: string): Promise<void> {
    await unlink(this.#file(tokenHash)).catch(() => undefined);
  }

  /**
   * Revokes every session for a user.
   *
   * Called when an account is disabled, demoted, has its password changed, or
   * is deleted — a privilege change must take effect immediately, not at the
   * next login (INV-17).
   */
  async revokeAllForUser(userId: string, options: { except?: string } = {}): Promise<number> {
    const keep = options.except !== undefined ? hashToken(options.except) : null;

    let entries: string[];
    try {
      entries = await readdir(this.#dir());
    } catch {
      return 0;
    }

    let revoked = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const tokenHash = entry.slice(0, -5);
      if (tokenHash === keep) continue;

      const record = await this.#read(tokenHash).catch(() => null);
      if (record?.userId !== userId) continue;

      await this.#destroyByHash(tokenHash);
      revoked += 1;
    }

    if (revoked > 0) this.#logger.info('Revoked sessions', { userId, revoked });
    return revoked;
  }

  /** Removes expired sessions. Run at startup; safe to call at any time. */
  async cleanupExpired(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir());
    } catch {
      return 0;
    }

    const now = this.#now().getTime();
    let removed = 0;

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const tokenHash = entry.slice(0, -5);

      const record = await this.#read(tokenHash).catch(() => null);
      // An unreadable session file is dead weight; it can never authenticate.
      if (
        record === null ||
        now >= Date.parse(record.expiresAt) ||
        now >= Date.parse(record.idleExpiresAt)
      ) {
        await this.#destroyByHash(tokenHash);
        removed += 1;
      }
    }

    if (removed > 0) this.#logger.info('Removed expired sessions', { removed });
    return removed;
  }
}
