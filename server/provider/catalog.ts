import type { ModelDto } from '@shared/generation.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import type { ProviderConfigEntry } from './registry.ts';
import type { Provider } from './types.ts';

/**
 * Model discovery cache, keyed by provider (contracts §5, INV-18).
 *
 * Discovery is slow and can fail, but a chat application must not become
 * unusable because a provider blinked. The policy:
 *
 *   - a successful refresh replaces the list and clears `stale`;
 *   - a **failed** refresh keeps the last good list and marks it `stale`, so
 *     the models a user was just using stay selectable;
 *   - a provider that has never succeeded is `unavailable` with an empty list;
 *   - discovery never blocks startup.
 *
 * Stale-while-revalidate: an expired entry is served immediately and refreshed
 * in the background, so a user never waits on a provider round trip.
 */

export interface ProviderModels {
  providerId: string;
  models: ModelDto[];
  status: 'ready' | 'unavailable';
  /** The list is from a previous successful fetch; the latest attempt failed. */
  stale: boolean;
  fetchedAt: string | null;
}

interface CacheEntry {
  models: ModelDto[];
  fetchedAt: number | null;
  stale: boolean;
  /** Never succeeded, so there is nothing to fall back to. */
  everSucceeded: boolean;
  inFlight: Promise<void> | null;
}

export interface ModelCatalogOptions {
  logger: Logger;
  /** How long a successful list is considered fresh. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

export class ModelCatalog {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #logger: Logger;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: ModelCatalogOptions) {
    this.#logger = options.logger;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  #entry(providerId: string): CacheEntry {
    let entry = this.#entries.get(providerId);
    if (entry === undefined) {
      entry = { models: [], fetchedAt: null, stale: false, everSucceeded: false, inFlight: null };
      this.#entries.set(providerId, entry);
    }
    return entry;
  }

  #isFresh(entry: CacheEntry): boolean {
    return entry.fetchedAt !== null && this.#now() - entry.fetchedAt < this.#ttlMs;
  }

  /** Fetches and stores, keeping the previous list if the attempt fails. */
  async refresh(config: ProviderConfigEntry, provider: Provider): Promise<ProviderModels> {
    const entry = this.#entry(config.id);

    // Coalesce: several callers hitting a cold provider must not each fetch.
    if (entry.inFlight !== null) {
      await entry.inFlight;
      return this.snapshot(config.id);
    }

    const run = (async (): Promise<void> => {
      try {
        const models = await provider.listModels();
        entry.models = models;
        entry.fetchedAt = this.#now();
        entry.stale = false;
        entry.everSucceeded = true;
      } catch (err) {
        // Only a success replaces the list.
        entry.stale = true;
        this.#logger.warn('Model discovery failed; keeping the last known list', {
          providerId: config.id,
          everSucceeded: entry.everSucceeded,
          error: err instanceof Error ? { name: err.name, message: err.message } : undefined,
        });
      } finally {
        entry.inFlight = null;
      }
    })();

    entry.inFlight = run;
    await run;
    return this.snapshot(config.id);
  }

  /**
   * Returns the cached list, refreshing when cold and revalidating in the
   * background when merely expired.
   */
  async get(config: ProviderConfigEntry, provider: Provider): Promise<ProviderModels> {
    const entry = this.#entry(config.id);

    if (!entry.everSucceeded) {
      return this.refresh(config, provider);
    }

    if (!this.#isFresh(entry) && entry.inFlight === null) {
      // Serve now, revalidate behind. A failure here only sets `stale`.
      void this.refresh(config, provider).catch(() => undefined);
    }

    return this.snapshot(config.id);
  }

  snapshot(providerId: string): ProviderModels {
    const entry = this.#entry(providerId);
    return {
      providerId,
      models: [...entry.models],
      status: entry.everSucceeded ? 'ready' : 'unavailable',
      stale: entry.stale,
      fetchedAt: entry.fetchedAt === null ? null : new Date(entry.fetchedAt).toISOString(),
    };
  }

  /**
   * Validates a `(providerId, modelId)` pair against the server-side cache,
   * refreshing **once** on a miss before rejecting (INV-18).
   *
   * The browser's pair is untrusted: a model it believes in is not a model the
   * provider will accept, and a stale UI must not be able to name anything it
   * likes.
   */
  async requireModel(
    config: ProviderConfigEntry,
    provider: Provider,
    modelId: string
  ): Promise<ModelDto> {
    const found = (await this.get(config, provider)).models.find((model) => model.id === modelId);
    if (found !== undefined) return found;

    // A model added since the last discovery is a legitimate miss, so try once
    // more before refusing.
    const refreshed = await this.refresh(config, provider);
    const retry = refreshed.models.find((model) => model.id === modelId);
    if (retry !== undefined) return retry;

    throw new AppError('MODEL_NOT_FOUND', 'The requested model is not available.');
  }

  /** Drops a provider's cache, used when it disappears from configuration. */
  forget(providerId: string): void {
    this.#entries.delete(providerId);
  }
}
