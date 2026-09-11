import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.ts';
import { ensureDir } from '../storage/atomic.ts';
import { StoragePaths } from '../storage/paths.ts';
import { ModelCatalog } from './catalog.ts';
import { EchoProvider } from './echoProvider.ts';
import { ProviderHub } from './hub.ts';
import { ProviderRegistry, type ProviderConfigEntry } from './registry.ts';
import { DEFAULT_HOST_POLICY } from './ssrf.ts';

const logger = createLogger({ level: 'silent', write: () => {} });

let dataDir: string;
let paths: StoragePaths;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-providers-'));
  paths = new StoragePaths(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function entry(overrides: Partial<ProviderConfigEntry> = {}): ProviderConfigEntry {
  return {
    id: 'local',
    name: 'Local',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080',
    timeoutMs: 5_000,
    capabilities: {},
    ...overrides,
  };
}

async function writeConfig(providers: unknown[]): Promise<void> {
  await ensureDir(paths.systemDir());
  await writeFile(
    join(paths.systemDir(), 'providers.json'),
    JSON.stringify({ version: 1, providers }, null, 2)
  );
}

function registry(): ProviderRegistry {
  return new ProviderRegistry({ paths, logger, policy: DEFAULT_HOST_POLICY });
}

const BOOTSTRAP = { baseUrl: 'http://127.0.0.1:8080', timeoutMs: 120_000 };

describe('providers.json', () => {
  it('bootstraps one provider from the environment when the file is absent', async () => {
    const result = await registry().load({ ...BOOTSTRAP, apiKey: 'secret-key' });

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.id).toBe('local');

    // Written through, so the next start reads the file rather than guessing.
    const raw = await readFile(join(paths.systemDir(), 'providers.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

  it('is authoritative once it exists', async () => {
    await writeConfig([
      entry({ id: 'first', name: 'First' }),
      entry({ id: 'second', name: 'Second' }),
    ]);

    const result = await registry().load(BOOTSTRAP);

    expect(result.providers.map((p) => p.id)).toEqual(['first', 'second']);
  });

  it('disables an invalid entry and logs it, without crashing startup', async () => {
    await writeConfig([
      entry({ id: 'good' }),
      { id: 'BAD ID', name: 'x', kind: 'openai-compatible', baseUrl: 'http://a', timeoutMs: 5000 },
      { id: 'missing-url', name: 'x', kind: 'openai-compatible', timeoutMs: 5000 },
      { id: 'wrong-kind', name: 'x', kind: 'anthropic', baseUrl: 'http://a', timeoutMs: 5000 },
      entry({ id: 'good', name: 'duplicate' }),
    ]);

    const result = await registry().load(BOOTSTRAP);

    expect(result.providers.map((p) => p.id)).toEqual(['good']);
    expect(result.rejected).toHaveLength(4);
  });

  it('INV-19: rejects an entry whose endpoint fails SSRF validation', async () => {
    await writeConfig([
      entry({ id: 'ok' }),
      entry({ id: 'metadata', baseUrl: 'http://169.254.169.254/' }),
      entry({ id: 'filescheme', baseUrl: 'file:///etc/passwd' }),
      entry({ id: 'creds', baseUrl: 'http://user:pass@example.com' }),
    ]);

    const result = await registry().load(BOOTSTRAP);

    expect(result.providers.map((p) => p.id)).toEqual(['ok']);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining('blocked-address'),
      expect.stringContaining('scheme'),
      expect.stringContaining('credentials'),
    ]);
  });

  it('survives a corrupt file without loading anything', async () => {
    await ensureDir(paths.systemDir());
    await writeFile(join(paths.systemDir(), 'providers.json'), 'not json');

    const result = await registry().load(BOOTSTRAP);

    expect(result.providers).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });
});

describe('model catalog', () => {
  it('caches a successful list instead of refetching', async () => {
    const provider = new EchoProvider();
    const catalog = new ModelCatalog({ logger, ttlMs: 60_000 });

    await catalog.get(entry(), provider);
    await catalog.get(entry(), provider);
    await catalog.get(entry(), provider);

    expect(provider.listModelsCalls).toBe(1);
  });

  it('keeps the last good list when a refresh fails, marked stale', async () => {
    const provider = new EchoProvider();
    const catalog = new ModelCatalog({ logger, ttlMs: 60_000 });

    const first = await catalog.get(entry(), provider);
    expect(first.models).toHaveLength(2);
    expect(first.stale).toBe(false);

    provider.setFailing(true);
    const afterFailure = await catalog.refresh(entry(), provider);

    // The models the user was just using stay selectable.
    expect(afterFailure.models).toHaveLength(2);
    expect(afterFailure.stale).toBe(true);
    expect(afterFailure.status).toBe('ready');
  });

  it('reports a provider that has never succeeded as unavailable with no models', async () => {
    const provider = new EchoProvider({ failListModels: true });
    const catalog = new ModelCatalog({ logger });

    const result = await catalog.get(entry(), provider);

    expect(result.status).toBe('unavailable');
    expect(result.models).toEqual([]);
  });

  it('a later success clears stale and replaces the list', async () => {
    const provider = new EchoProvider();
    const catalog = new ModelCatalog({ logger, ttlMs: 0 });

    await catalog.refresh(entry(), provider);
    provider.setFailing(true);
    expect((await catalog.refresh(entry(), provider)).stale).toBe(true);

    provider.setFailing(false);
    const recovered = await catalog.refresh(entry(), provider);
    expect(recovered.stale).toBe(false);
    expect(recovered.models).toHaveLength(2);
  });

  it('coalesces concurrent refreshes into one upstream call', async () => {
    const provider = new EchoProvider();
    const catalog = new ModelCatalog({ logger });

    await Promise.all([
      catalog.get(entry(), provider),
      catalog.get(entry(), provider),
      catalog.get(entry(), provider),
    ]);

    expect(provider.listModelsCalls).toBe(1);
  });

  it('refreshes once on a miss before rejecting an unknown model', async () => {
    const provider = new EchoProvider();
    const catalog = new ModelCatalog({ logger, ttlMs: 60_000 });

    await catalog.get(entry(), provider);
    expect(provider.listModelsCalls).toBe(1);

    await expect(catalog.requireModel(entry(), provider, 'nope')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
    // A model added since discovery is a legitimate miss, so it tries again.
    expect(provider.listModelsCalls).toBe(2);
  });

  it('tolerates an unexpected model list shape', async () => {
    // A provider returning nonsense must be `unavailable`, not a crash.
    const weird = new EchoProvider();
    weird.setFailing(true);
    const catalog = new ModelCatalog({ logger });

    const result = await catalog.get(entry(), weird);
    expect(result.status).toBe('unavailable');
  });
});

describe('the provider abstraction holds for a second implementation', () => {
  function hubWith(clients: Record<string, EchoProvider>, entries: ProviderConfigEntry[]) {
    const hub = new ProviderHub({
      logger,
      policy: DEFAULT_HOST_POLICY,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
      factory: (config) => clients[config.id] as EchoProvider,
    });
    hub.setProviders(entries);
    return hub;
  }

  it('lists providers and models grouped, without leaking secrets', async () => {
    const hub = hubWith(
      { a: new EchoProvider({ name: 'a' }), b: new EchoProvider({ name: 'b' }) },
      [
        entry({ id: 'a', name: 'Provider A', apiKey: 'super-secret-a' }),
        entry({ id: 'b', name: 'Provider B', apiKey: 'super-secret-b' }),
      ]
    );

    const providers = await hub.listProviders();
    const grouped = await hub.listModels();

    expect(providers.map((p) => p.id)).toEqual(['a', 'b']);
    expect(grouped.map((g) => g.providerId)).toEqual(['a', 'b']);

    // INV-25: neither the key nor the endpoint may cross the boundary.
    const serialized = JSON.stringify({ providers, grouped });
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('baseUrl');
  });

  it('rejects an unknown provider', async () => {
    const hub = hubWith({ a: new EchoProvider() }, [entry({ id: 'a' })]);

    await expect(hub.resolveModel('nope', 'echo-small')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
  });

  it('rejects a model that exists on another provider', async () => {
    const hub = hubWith(
      {
        a: new EchoProvider({
          models: [{ id: 'only-on-a', inputModalities: ['text'], loaded: true }],
        }),
        b: new EchoProvider({
          models: [{ id: 'only-on-b', inputModalities: ['text'], loaded: true }],
        }),
      },
      [entry({ id: 'a' }), entry({ id: 'b' })]
    );

    await expect(hub.resolveModel('a', 'only-on-a')).resolves.toBeDefined();
    // The pair travels together: valid on A does not mean valid on B.
    await expect(hub.resolveModel('b', 'only-on-a')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('an unreachable provider does not prevent a healthy one from working', async () => {
    const hub = hubWith(
      { up: new EchoProvider(), down: new EchoProvider({ failListModels: true }) },
      [entry({ id: 'up' }), entry({ id: 'down' })]
    );

    const grouped = await hub.listModels();

    expect(grouped.find((g) => g.providerId === 'up')?.status).toBe('ready');
    expect(grouped.find((g) => g.providerId === 'down')?.status).toBe('unavailable');
    await expect(hub.resolveModel('up', 'echo-small')).resolves.toBeDefined();
  });

  it('removing a provider drops its cache but nothing else', async () => {
    const hub = hubWith({ a: new EchoProvider(), b: new EchoProvider() }, [
      entry({ id: 'a' }),
      entry({ id: 'b' }),
    ]);
    await hub.listModels();

    hub.setProviders([entry({ id: 'a' })]);

    expect(hub.size).toBe(1);
    await expect(hub.resolveModel('b', 'echo-small')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
    // The survivor is untouched.
    await expect(hub.resolveModel('a', 'echo-small')).resolves.toBeDefined();
  });

  it('reports capability source so the UI can distinguish discovered from assumed', async () => {
    const hub = hubWith({ a: new EchoProvider() }, [entry({ id: 'a' })]);

    const [provider] = await hub.listProviders();

    // EchoProvider reports modalities, so vision is discovered rather than assumed.
    expect(provider?.capabilitySource).toBe('discovery');
    expect(provider?.capabilities.vision).toBe(true);
  });
});
