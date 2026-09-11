import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../config.ts';
import { isAppError } from '../errors/AppError.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from './llamacpp.ts';
import { startMockProvider, type MockProvider, type MockProviderOptions } from './mockServer.ts';

const logger = createLogger({ level: 'silent', write: () => {} });

let mock: MockProvider | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function provider(
  options: MockProviderOptions = {},
  overrides: Partial<ProviderConfig> = {}
): Promise<LlamaCppProvider> {
  mock = await startMockProvider(options);
  return new LlamaCppProvider(
    {
      baseUrl: mock.url,
      apiKey: undefined,
      timeoutMs: 5_000,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
      ...overrides,
    },
    logger
  );
}

async function collect(iterable: AsyncIterable<{ type: string; text?: string; reason?: string }>) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('LlamaCppProvider.listModels', () => {
  it('maps entries to the narrow DTO', async () => {
    const p = await provider();

    const models = await p.listModels();

    expect(models).toEqual([
      { id: 'GPT', inputModalities: ['text'], loaded: true },
      { id: 'Qwen Mini', inputModalities: ['text', 'image'], loaded: false },
    ]);
  });

  it('INV-04: drops status.args and status.preset, which leak the API key path', async () => {
    const p = await provider();

    const models = await p.listModels();

    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain('api-key-file');
    expect(serialized).not.toContain('/run/api-key');
    expect(serialized).not.toContain('llama-server');
    expect(serialized).not.toContain('.gguf');
    for (const model of models) {
      expect(Object.keys(model).sort()).toEqual(['id', 'inputModalities', 'loaded']);
    }
  });

  describe('unexpected model list shapes', () => {
    it('rejects a body that is not a model list', async () => {
      for (const payload of [
        {},
        { data: null },
        { data: 'not an array' },
        { data: { id: 'not-an-array' } },
        [],
        'plain text',
      ]) {
        const p = await provider({ modelsPayload: payload });
        await expect(p.listModels(), JSON.stringify(payload)).rejects.toMatchObject({
          code: 'PROVIDER_ERROR',
        });
        await mock?.close();
        mock = undefined;
      }
    });

    it('rejects a body that is not valid JSON at all', async () => {
      const p = await provider({ modelsPayload: '{ this is not json' });

      await expect(p.listModels()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('skips individual entries that have no usable id, keeping the rest', async () => {
      // A provider that adds a field we do not understand must not break
      // discovery; only an entry with no id is unusable.
      const p = await provider({
        modelsPayload: {
          object: 'list',
          data: [
            { id: 'good-one', architecture: { input_modalities: ['text'] } },
            { id: '' },
            { id: 42 },
            { noIdAtAll: true },
            null,
            { id: 'good-two', surprising_new_field: { nested: true } },
          ],
        },
      });

      const models = await p.listModels();

      expect(models.map((m) => m.id)).toEqual(['good-one', 'good-two']);
      // An entry with no declared modalities still gets a sane default.
      expect(models[1]?.inputModalities).toEqual(['text']);
    });

    it('ignores modality values it does not recognise', async () => {
      const p = await provider({
        modelsPayload: {
          data: [{ id: 'm', architecture: { input_modalities: ['text', 'hologram', 7, null] } }],
        },
      });

      expect((await p.listModels())[0]?.inputModalities).toEqual(['text']);
    });
  });

  it('preserves model ids containing spaces', async () => {
    const p = await provider({ models: ['Qwen Max', 'North Mini'] });

    const models = await p.listModels();

    expect(models.map((m) => m.id)).toEqual(['Qwen Max', 'North Mini']);
  });

  it('sends the bearer token upstream but never returns it', async () => {
    const p = await provider({ requireApiKey: 'secret-key' }, { apiKey: 'secret-key' });

    const models = await p.listModels();

    expect(mock?.requests[0]?.authorization).toBe('Bearer secret-key');
    expect(JSON.stringify(models)).not.toContain('secret-key');
  });

  it('normalizes an auth failure without leaking the upstream body', async () => {
    const p = await provider({ requireApiKey: 'right' }, { apiKey: 'wrong' });

    const error = await p.listModels().catch((e: unknown) => e);

    expect(isAppError(error) && error.code).toBe('PROVIDER_ERROR');
    expect((error as Error).message).not.toContain('Invalid API Key');
    expect(JSON.stringify(error)).not.toContain('right');
  });

  it('reports an unreachable provider as PROVIDER_UNAVAILABLE', async () => {
    mock = await startMockProvider();
    const url = mock.url;
    await mock.close();
    mock = undefined;

    const p = new LlamaCppProvider(
      {
        baseUrl: url,
        apiKey: undefined,
        timeoutMs: 2_000,
        defaultContextTokens: 8_192,
        maxOutputTokens: 128,
      },
      logger
    );

    await expect(p.listModels()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('LlamaCppProvider.streamChat', () => {
  const request = (signal: AbortSignal) => ({
    model: 'GPT',
    messages: [{ role: 'user' as const, content: 'hi' }],
    maxOutputTokens: 64,
    signal,
  });

  it('separates reasoning from content', async () => {
    const p = await provider({
      reasoningChunks: ['think ', 'harder'],
      contentChunks: ['Hello', ' there'],
    });

    const chunks = await collect(p.streamChat(request(new AbortController().signal)));

    expect(chunks.filter((c) => c.type === 'reasoning').map((c) => c.text)).toEqual([
      'think ',
      'harder',
    ]);
    expect(chunks.filter((c) => c.type === 'content').map((c) => c.text)).toEqual([
      'Hello',
      ' there',
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('survives a null content delta and an empty choices array', async () => {
    // The mock always emits both shapes; reaching a clean finish proves the
    // parser guards them (provider notes §5).
    const p = await provider({ reasoningChunks: [], contentChunks: ['ok'] });

    const chunks = await collect(p.streamChat(request(new AbortController().signal)));

    expect(chunks).toEqual([
      { type: 'content', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('skips an unparseable frame instead of failing the stream', async () => {
    const p = await provider({ emitGarbageFrame: true, contentChunks: ['fine'] });

    const chunks = await collect(p.streamChat(request(new AbortController().signal)));

    expect(chunks.some((c) => c.type === 'content' && c.text === 'fine')).toBe(true);
  });

  it('raises PROVIDER_ERROR on a mid-stream error frame', async () => {
    const p = await provider({ errorMidStream: true });

    await expect(
      collect(p.streamChat(request(new AbortController().signal)))
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('maps an unknown model to MODEL_NOT_FOUND', async () => {
    const p = await provider({
      failWith: { status: 400, message: "model 'nope' not found", type: 'invalid_request_error' },
    });

    await expect(
      collect(p.streamChat(request(new AbortController().signal)))
    ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('maps an oversized prompt without disclosing n_ctx', async () => {
    const p = await provider({
      failWith: {
        status: 400,
        type: 'exceed_context_size_error',
        message: 'request (400068 tokens) exceeds the available context size (131072 tokens)',
      },
    });

    const error = await collect(p.streamChat(request(new AbortController().signal))).catch(
      (e: unknown) => e
    );

    expect(isAppError(error) && error.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(error)).not.toContain('131072');
    expect((error as Error).message).not.toContain('400068');
  });

  it('times out slowly enough to be distinguishable from a failure', async () => {
    const p = await provider({ hang: true }, { timeoutMs: 1_000 });

    await expect(
      collect(p.streamChat(request(new AbortController().signal)))
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('propagates a caller abort rather than reporting a provider failure', async () => {
    const p = await provider({ chunkDelayMs: 50, contentChunks: ['a', 'b', 'c', 'd'] });
    const controller = new AbortController();

    const iterator = p.streamChat(request(controller.signal))[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();

    await expect(iterator.next()).rejects.toSatisfy(
      (err: unknown) => !isAppError(err) || err.code !== 'PROVIDER_UNAVAILABLE'
    );
  });
});
