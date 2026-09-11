import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import { ModelCatalog, type ProviderModels } from './catalog.ts';
import { LlamaCppProvider } from './llamacpp.ts';
import { toProviderDto, type ProviderConfigEntry, type ProviderDto } from './registry.ts';
import type { HostPolicy, Resolver } from './ssrf.ts';
import type { Provider } from './types.ts';

/**
 * The single place the rest of the application asks about providers.
 *
 * A model is identified by the **pair** `(providerId, modelId)`. Model ids are
 * opaque strings that are never parsed, and the same id can legitimately exist
 * on two providers meaning different things — so the pair travels together and
 * is validated together (INV-18).
 */

/** Builds the client for a config entry. Swappable so tests can supply their own. */
export type ProviderFactory = (entry: ProviderConfigEntry) => Provider;

export interface ProviderHubOptions {
  logger: Logger;
  policy: HostPolicy;
  resolver?: Resolver;
  catalog?: ModelCatalog;
  /** Overrides client construction; the default builds an OpenAI-compatible client. */
  factory?: ProviderFactory;
  defaultContextTokens: number;
  maxOutputTokens: number;
}

export interface GroupedModels {
  providerId: string;
  providerName: string;
  status: ProviderModels['status'];
  stale: boolean;
  models: { id: string; inputModalities: string[]; loaded: boolean }[];
}

export class ProviderHub {
  readonly #logger: Logger;
  readonly #catalog: ModelCatalog;
  readonly #factory: ProviderFactory;
  readonly #entries = new Map<string, ProviderConfigEntry>();
  readonly #clients = new Map<string, Provider>();

  constructor(options: ProviderHubOptions) {
    this.#logger = options.logger;
    this.#catalog = options.catalog ?? new ModelCatalog({ logger: options.logger });
    this.#factory =
      options.factory ??
      ((entry) =>
        new LlamaCppProvider(
          {
            baseUrl: entry.baseUrl,
            apiKey: entry.apiKey,
            timeoutMs: entry.timeoutMs,
            defaultContextTokens: entry.contextTokens ?? options.defaultContextTokens,
            maxOutputTokens: options.maxOutputTokens,
          },
          options.logger,
          {
            policy: options.policy,
            ...(options.resolver !== undefined ? { resolver: options.resolver } : {}),
          }
        ));
  }

  /**
   * Replaces the configured set.
   *
   * A provider that disappears has its client and cache dropped, but **nothing
   * touches conversations**: old assistant blocks keep the `provider`/`model`
   * they recorded, and new generations simply cannot select it.
   */
  setProviders(entries: ProviderConfigEntry[]): void {
    const next = new Set(entries.map((entry) => entry.id));

    for (const id of [...this.#entries.keys()]) {
      if (next.has(id)) continue;
      this.#entries.delete(id);
      this.#clients.delete(id);
      this.#catalog.forget(id);
      this.#logger.info('Provider removed from configuration', { providerId: id });
    }

    for (const entry of entries) {
      this.#entries.set(entry.id, entry);
      // Rebuild the client so an edited endpoint takes effect.
      this.#clients.set(entry.id, this.#factory(entry));
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  #require(providerId: string): { entry: ProviderConfigEntry; client: Provider } {
    const entry = this.#entries.get(providerId);
    const client = this.#clients.get(providerId);
    if (entry === undefined || client === undefined) {
      throw new AppError('PROVIDER_NOT_FOUND', 'That provider is not configured.');
    }
    return { entry, client };
  }

  /** Non-sensitive listing: no baseUrl, no apiKey (INV-25). */
  async listProviders(): Promise<ProviderDto[]> {
    const dtos: ProviderDto[] = [];

    for (const entry of this.#entries.values()) {
      const client = this.#clients.get(entry.id);
      if (client === undefined) continue;

      const models = await this.#catalog.get(entry, client);
      // Capabilities come from discovery when the provider actually reports
      // modalities (docs/provider-notes.md §2 shows llama.cpp does), and from
      // config otherwise. The source is reported so the UI can say "assumed".
      const discovered = models.models.some((model) => model.inputModalities.length > 0);
      const capabilities = discovered
        ? {
            vision: models.models.some((model) => model.inputModalities.includes('image')),
            ...(entry.capabilities.reasoning !== undefined
              ? { reasoning: entry.capabilities.reasoning }
              : {}),
          }
        : entry.capabilities;

      dtos.push(
        toProviderDto(
          { ...entry, capabilities },
          models.status,
          discovered ? 'discovery' : 'config'
        )
      );
    }

    return dtos;
  }

  /** Models grouped by provider, with `stale` and `status` flags for the UI. */
  async listModels(): Promise<GroupedModels[]> {
    const groups: GroupedModels[] = [];

    for (const entry of this.#entries.values()) {
      const client = this.#clients.get(entry.id);
      if (client === undefined) continue;

      const models = await this.#catalog.get(entry, client);
      groups.push({
        providerId: entry.id,
        providerName: entry.name,
        status: models.status,
        stale: models.stale,
        models: models.models.map((model) => ({
          id: model.id,
          inputModalities: model.inputModalities,
          loaded: model.loaded,
        })),
      });
    }

    return groups;
  }

  /**
   * Validates a pair against the server-side cache and returns the client.
   *
   * The browser's pair is untrusted: a model valid on provider A must not be
   * accepted against provider B just because the client said so.
   */
  async resolveModel(
    providerId: string,
    modelId: string
  ): Promise<{ entry: ProviderConfigEntry; client: Provider }> {
    const { entry, client } = this.#require(providerId);
    await this.#catalog.requireModel(entry, client, modelId);
    return { entry, client };
  }

  /** Forces rediscovery for one provider, or all of them. */
  async refresh(providerId?: string): Promise<void> {
    const ids = providerId === undefined ? [...this.#entries.keys()] : [providerId];

    for (const id of ids) {
      const entry = this.#entries.get(id);
      const client = this.#clients.get(id);
      if (entry === undefined || client === undefined) continue;
      await this.#catalog.refresh(entry, client);
    }
  }

  /**
   * Warms discovery without blocking startup.
   *
   * A provider that is down must not delay or prevent the server accepting
   * requests; it simply shows as unavailable until it recovers.
   */
  warm(): void {
    void this.refresh().catch(() => undefined);
  }
}
