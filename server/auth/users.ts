import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  isValidUsername,
  normalizeUsername,
  type UserDto,
  type UserRole,
  type UserStatus,
} from '@shared/auth.ts';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import { atomicWriteFile, ensureDir } from '../storage/atomic.ts';
import { KeyedLock } from '../storage/locks.ts';
import type { StoragePaths } from '../storage/paths.ts';

/**
 * Accounts (contracts §6).
 *
 * `data/<user-uuid>/user.json` is canonical; `_system/users.index.json` is a
 * derived username → id map, rebuilt from the canonical records whenever it is
 * missing or unusable.
 *
 * `passwordHash` never leaves this module: `toDto` is the only way a user
 * crosses a boundary, and it cannot carry the hash (INV-03, INV-25).
 */

/** The stored record. Deliberately not exported — see `toDto`. */
interface UserRecord {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

const recordSchema = z.strictObject({
  id: z.string(),
  username: z.string(),
  role: z.enum(['user', 'admin']),
  status: z.enum(['active', 'disabled']),
  passwordHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** OWASP-recommended Argon2id parameters. No custom crypto (contracts §6). */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Deliberately weak parameters, for tests only.
 *
 * Hashing is *meant* to be slow, which makes a suite that creates an account
 * per test both sluggish and prone to starving timing-sensitive tests of CPU.
 * Tests opt in explicitly; the strong parameters remain the default, so
 * production cannot get these by omission.
 */
export const ARGON2_TEST_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 64,
  timeCost: 1,
  parallelism: 1,
} as const;

/** Single key: registration and username changes serialise against each other. */
const REGISTRY_KEY = 'users';

export function toDto(record: {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}): UserDto {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    status: record.status,
    createdAt: record.createdAt,
  };
}

export class UserStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #lock = new KeyedLock();
  readonly #now: () => Date;
  readonly #argon2Options: typeof ARGON2_OPTIONS | typeof ARGON2_TEST_OPTIONS;

  constructor(options: {
    paths: StoragePaths;
    logger: Logger;
    now?: () => Date;
    /** Tests pass `ARGON2_TEST_OPTIONS`; production must not. */
    argon2Options?: typeof ARGON2_TEST_OPTIONS;
  }) {
    this.#paths = options.paths;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#argon2Options = options.argon2Options ?? ARGON2_OPTIONS;
  }

  #userFile(userId: string): string {
    return join(this.#paths.userDir(userId), 'user.json');
  }

  #registryFile(): string {
    return join(this.#paths.systemDir(), 'users.index.json');
  }

  /** Reads the canonical record. Returns `null` when absent or unparseable. */
  async #read(userId: string): Promise<UserRecord | null> {
    if (!isCanonicalUuid(userId)) return null;

    let raw: string;
    try {
      raw = await readFile(this.#userFile(userId), 'utf8');
    } catch {
      return null;
    }

    try {
      const parsed = recordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.#logger.warn('Account record has an unexpected shape', { userId });
        return null;
      }
      return parsed.data;
    } catch {
      this.#logger.warn('Account record is not valid JSON', { userId });
      return null;
    }
  }

  async #write(record: UserRecord): Promise<void> {
    await ensureDir(this.#paths.userDir(record.id));
    await atomicWriteFile(this.#userFile(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Scans every user directory for a canonical record.
   *
   * The registry is derived, so this is the authority whenever it is missing or
   * stale — a hand-deleted `users.index.json` costs a scan, not an account.
   */
  async #scan(): Promise<UserRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#paths.root);
    } catch {
      return [];
    }

    const records: UserRecord[] = [];
    for (const entry of entries) {
      if (!isCanonicalUuid(entry)) continue;
      const record = await this.#read(entry);
      if (record !== null) records.push(record);
    }
    return records;
  }

  /** Rebuilds `_system/users.index.json` from the canonical records. */
  async rebuildRegistry(): Promise<Record<string, string>> {
    const records = await this.#scan();
    const map: Record<string, string> = {};
    for (const record of records) map[normalizeUsername(record.username)] = record.id;

    await ensureDir(this.#paths.systemDir());
    await atomicWriteFile(this.#registryFile(), `${JSON.stringify(map, null, 2)}\n`);
    return map;
  }

  async #registry(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#registryFile(), 'utf8'));
      const map = z.record(z.string(), z.string()).safeParse(parsed);
      if (map.success) return map.data;
    } catch {
      // Missing or unusable; fall through to a rebuild.
    }
    return this.rebuildRegistry();
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    const id = (await this.#registry())[normalizeUsername(username)];
    if (id === undefined) return null;

    const record = await this.#read(id);
    // A registry entry pointing at a missing record means the registry is
    // stale; the canonical record wins, so rebuild and retry once.
    if (record === null) {
      const rebuilt = await this.rebuildRegistry();
      const retryId = rebuilt[normalizeUsername(username)];
      return retryId === undefined ? null : this.#read(retryId);
    }
    return record;
  }

  async findById(userId: string): Promise<UserRecord | null> {
    return this.#read(userId);
  }

  async count(): Promise<number> {
    return (await this.#scan()).length;
  }

  /**
   * Creates an account under the registry lock, so two concurrent registrations
   * of the same username cannot both succeed.
   */
  async create(options: {
    username: string;
    password: string;
    role?: UserRole;
    /** Adopts `data/<id>/` that already exists, for Phase 3 data (contracts §6). */
    id?: string;
  }): Promise<UserDto> {
    const username = normalizeUsername(options.username);
    if (!isValidUsername(username)) {
      throw AppError.validation('Username must be 3-32 characters of a-z, 0-9, _, . or -');
    }

    return this.#lock.run(REGISTRY_KEY, async () => {
      if ((await this.findByUsername(username)) !== null) {
        throw new AppError('CONFLICT', 'That username is already taken.');
      }

      const id = options.id ?? randomUUID();
      if (!isCanonicalUuid(id)) {
        throw AppError.validation('User id must be a canonical lowercase UUID.');
      }
      if ((await this.#read(id)) !== null) {
        throw new AppError('CONFLICT', 'An account already exists for that id.');
      }

      const now = this.#now().toISOString();
      const record: UserRecord = {
        id,
        username,
        role: options.role ?? 'user',
        status: 'active',
        passwordHash: await argon2.hash(options.password, this.#argon2Options),
        createdAt: now,
        updatedAt: now,
      };

      await this.#write(record);
      await this.rebuildRegistry();

      this.#logger.info('Account created', { userId: id, role: record.role });
      return toDto(record);
    });
  }

  /**
   * Verifies a password.
   *
   * A missing account still pays for a hash comparison, so response time does
   * not reveal whether a username exists.
   */
  async verify(username: string, password: string): Promise<UserRecord | null> {
    const record = await this.findByUsername(username);

    if (record === null) {
      await argon2.hash(password, this.#argon2Options).catch(() => undefined);
      return null;
    }

    const ok = await argon2.verify(record.passwordHash, password).catch(() => false);
    return ok ? record : null;
  }

  /**
   * Changes an account's username.
   *
   * Under the registry lock, and against the registry rather than the record,
   * because uniqueness is a property of the set: two renames racing towards the
   * same name would each find it free.
   *
   * The id never changes, so nothing that refers to this account — a session, a
   * conversation directory, a pin — has to be rewritten.
   */
  async rename(userId: string, username: string): Promise<UserDto> {
    const next = normalizeUsername(username);
    if (!isValidUsername(next)) {
      throw AppError.validation('Username must be 3-32 characters of a-z, 0-9, _, . or -');
    }

    return this.#lock.run(REGISTRY_KEY, async () => {
      const record = await this.#read(userId);
      if (record === null) throw AppError.notFound('Account not found.');
      if (record.username === next) return toDto(record);

      const taken = await this.findByUsername(next);
      if (taken !== null) throw new AppError('CONFLICT', 'That username is already taken.');

      const updated: UserRecord = {
        ...record,
        username: next,
        updatedAt: this.#now().toISOString(),
      };
      await this.#write(updated);
      await this.rebuildRegistry();

      this.#logger.info('Account renamed', { userId });
      return toDto(updated);
    });
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const record = await this.#read(userId);
    if (record === null) throw AppError.notFound('Account not found.');

    await this.#write({
      ...record,
      passwordHash: await argon2.hash(password, this.#argon2Options),
      updatedAt: this.#now().toISOString(),
    });
  }

  async update(
    userId: string,
    changes: { role?: UserRole; status?: UserStatus }
  ): Promise<UserDto> {
    const record = await this.#read(userId);
    if (record === null) throw AppError.notFound('Account not found.');

    const next: UserRecord = {
      ...record,
      ...(changes.role !== undefined ? { role: changes.role } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      updatedAt: this.#now().toISOString(),
    };
    await this.#write(next);
    return toDto(next);
  }

  /** Removes the account **and everything it owns** (contracts §1). */
  async delete(userId: string): Promise<void> {
    return this.#lock.run(REGISTRY_KEY, async () => {
      const record = await this.#read(userId);
      if (record === null) throw AppError.notFound('Account not found.');

      await rm(this.#paths.userDir(userId), { recursive: true, force: true });
      await this.rebuildRegistry();
      this.#logger.info('Account deleted', { userId });
    });
  }

  async list(): Promise<UserDto[]> {
    const records = await this.#scan();
    return records
      .map((record) => toDto(record))
      .sort((a, b) => a.username.localeCompare(b.username));
  }
}
