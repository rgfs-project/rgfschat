import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { atomicWriteFile, ensureDir } from '../storage/atomic.ts';
import type { StoragePaths } from '../storage/paths.ts';
import { SsrfError, validateProviderUrl, type HostPolicy } from './ssrf.ts';

/**
 * Provider configuration — `_system/providers.json` (contracts §1).
 *
 * **This file holds secrets**: `apiKey` is stored in plaintext at rest, which
 * is why the file is 0600 and why backups of `data/` must be treated as
 * secret. It never reaches a response; `toDto` below is the only way a
 * provider crosses a boundary (INV-25).
 *
 * Admin editing arrives in Phase 9. For now the file is edited by hand and the
 * server restarted.
 */

export interface ProviderCapabilities {
  vision?: boolean | undefined;
  reasoning?: boolean | undefined;
}

export interface ProviderConfigEntry {
  id: string;
  name: string;
  kind: 'openai-compatible';
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  capabilities: ProviderCapabilities;
  /** Optional override when the provider will not disclose its context length. */
  contextTokens?: number | undefined;
}

/** What the browser may know. Deliberately cannot carry `apiKey` or `baseUrl`. */
export interface ProviderDto {
  id: string;
  name: string;
  status: 'ready' | 'unavailable';
  capabilities: ProviderCapabilities;
  /** Where the capability values came from, so the UI can say "assumed". */
  capabilitySource: 'discovery' | 'config';
}

const entrySchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    // Used as a map key and rendered in the UI; kept boring on purpose.
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'provider id must be lowercase alphanumeric, _ or -'),
  name: z.string().min(1).max(100),
  kind: z.literal('openai-compatible'),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  capabilities: z
    .strictObject({ vision: z.boolean().optional(), reasoning: z.boolean().optional() })
    .default({}),
  contextTokens: z.number().int().min(512).max(2_000_000).optional(),
});

const fileSchema = z.strictObject({
  version: z.literal(1),
  providers: z.array(z.unknown()),
});

export function toProviderDto(
  entry: ProviderConfigEntry,
  status: ProviderDto['status'],
  capabilitySource: ProviderDto['capabilitySource']
): ProviderDto {
  return {
    id: entry.id,
    name: entry.name,
    status,
    capabilities: entry.capabilities,
    capabilitySource,
  };
}

export interface LoadResult {
  providers: ProviderConfigEntry[];
  /** Entries that failed validation. Disabled and logged, never fatal. */
  rejected: { index: number; reason: string }[];
}

export class ProviderRegistry {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #policy: HostPolicy;

  constructor(options: { paths: StoragePaths; logger: Logger; policy: HostPolicy }) {
    this.#paths = options.paths;
    this.#logger = options.logger;
    this.#policy = options.policy;
  }

  #file(): string {
    return join(this.#paths.systemDir(), 'providers.json');
  }

  /**
   * Loads the file. When absent, returns an empty provider list — no dummy
   * provider is created on first boot; one must be added manually or via the
   * admin panel.
   *
   * An invalid entry is disabled and logged rather than crashing startup: one
   * bad provider must not make the whole application unbootable.
   */
  async load(_bootstrap: {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
  }): Promise<LoadResult> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.#file(), 'utf8');
    } catch {
      raw = null;
    }

    if (raw === null) {
      this.#logger.info('No providers configured; add one via the admin panel or edit _system/providers.json', {});
      return { providers: [], rejected: [] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#logger.error('providers.json is not valid JSON; no providers loaded', {});
      return { providers: [], rejected: [{ index: -1, reason: 'file is not valid JSON' }] };
    }

    const file = fileSchema.safeParse(parsed);
    if (!file.success) {
      this.#logger.error('providers.json has an unexpected shape; no providers loaded', {});
      return { providers: [], rejected: [{ index: -1, reason: 'unexpected file shape' }] };
    }

    const providers: ProviderConfigEntry[] = [];
    const rejected: LoadResult['rejected'] = [];
    const seen = new Set<string>();

    for (const [index, candidate] of file.data.providers.entries()) {
      const entry = entrySchema.safeParse(candidate);
      if (!entry.success) {
        rejected.push({ index, reason: entry.error.issues[0]?.message ?? 'invalid entry' });
        continue;
      }

      if (seen.has(entry.data.id)) {
        rejected.push({ index, reason: `duplicate provider id "${entry.data.id}"` });
        continue;
      }

      // SSRF validation runs on load as well as per request, so a bad endpoint
      // is caught before anything tries to use it (INV-19).
      try {
        validateProviderUrl(entry.data.baseUrl, this.#policy);
      } catch (err) {
        rejected.push({
          index,
          reason:
            err instanceof SsrfError ? `endpoint rejected (${err.reason})` : 'endpoint rejected',
        });
        continue;
      }

      seen.add(entry.data.id);
      providers.push({ ...entry.data, baseUrl: entry.data.baseUrl.replace(/\/+$/, '') });
    }

    for (const { index, reason } of rejected) {
      // The reason names the problem, never the URL or key.
      this.#logger.warn('Disabled an invalid provider entry', { index, reason });
    }

    return { providers, rejected };
  }

  async save(entries: ProviderConfigEntry[]): Promise<void> {
    await ensureDir(this.#paths.systemDir());
    await atomicWriteFile(
      this.#file(),
      `${JSON.stringify({ version: 1, providers: entries }, null, 2)}\n`
    );
  }
}
