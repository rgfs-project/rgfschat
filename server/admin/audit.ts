import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from '../storage/atomic.ts';
import type { StoragePaths } from '../storage/paths.ts';
import type { Logger } from '../logger.ts';

/**
 * Administrative audit log.
 *
 * One JSON object per line in `_system/audit/<yyyy-mm>.jsonl`. Line-delimited
 * rather than a single document so an append is one write with no read-modify-
 * write cycle to lose entries to, and so a truncated final line costs one
 * record rather than the file.
 *
 * **Entries never carry secrets, passwords, or message content.** The log
 * records that an action happened, to what, and whether it succeeded — enough
 * to answer "who changed this" without becoming a second place secrets live.
 * `details` is deliberately narrow: booleans, counts, and identifiers only.
 */

export type AuditOutcome = 'success' | 'failure';

export interface AuditEntry {
  timestamp: string;
  actorId: string;
  actorUsername: string;
  action: string;
  /** What was acted on: a user id, a provider id, a settings key. */
  target: string | null;
  outcome: AuditOutcome;
  /** Non-sensitive specifics only; see the note above. */
  details?: Record<string, string | number | boolean | null>;
}

/** Values that must never reach the log, whatever a caller passes. */
const FORBIDDEN_DETAIL_KEYS = new Set([
  'apikey',
  'api_key',
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'token',
  'csrftoken',
  'secret',
  'body',
  'content',
  'message',
]);

/**
 * Drops anything that looks like a secret or like message content.
 *
 * A belt-and-braces filter rather than a promise that call sites behave: the
 * cost of one careless `details` object is a credential written to a file that
 * is meant to be safe to read and to ship to whoever investigates an incident.
 */
export function scrubDetails(
  details: Record<string, unknown> | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (details === undefined) return undefined;

  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) continue;
    if (value === null) safe[key] = null;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    }
    // Anything else (objects, arrays, functions) is dropped: it cannot be
    // summarised safely without knowing what it holds.
  }
  return Object.keys(safe).length === 0 ? undefined : safe;
}

export class AuditLog {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(options: { paths: StoragePaths; logger: Logger; now?: () => Date }) {
    this.#paths = options.paths;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  /** `_system/audit/<yyyy-mm>.jsonl` for the entry's month. */
  fileFor(date: Date): string {
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    return join(this.#paths.auditDir(), `${month}.jsonl`);
  }

  /**
   * Appends one entry.
   *
   * Never throws: an audit failure must not turn a successful administrative
   * action into an error the operator has to guess about. It is logged instead,
   * which is itself visible.
   */
  async record(entry: Omit<AuditEntry, 'timestamp'> & { timestamp?: string }): Promise<void> {
    const date = this.#now();
    const details = scrubDetails(entry.details);
    const record: AuditEntry = {
      timestamp: entry.timestamp ?? date.toISOString(),
      actorId: entry.actorId,
      actorUsername: entry.actorUsername,
      action: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      ...(details === undefined ? {} : { details }),
    };

    try {
      await ensureDir(this.#paths.auditDir());
      await appendFile(this.fileFor(date), `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      this.#logger.error('Could not write an audit entry', {
        action: record.action,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
}
