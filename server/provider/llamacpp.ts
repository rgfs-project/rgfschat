import type { ChatMessage, ModelDto, Modality } from '@shared/generation.ts';
import type { ProviderConfig } from '../config.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import { safeFetch, SsrfError, type HostPolicy, type Resolver } from './ssrf.ts';
import type { Response as UndiciResponse } from 'undici';
import { DEFAULT_HOST_POLICY } from './ssrf.ts';
import type { ChatRequest, Provider, ProviderChunk } from './types.ts';

/**
 * llama.cpp (`llama-server`) provider.
 *
 * Written against observed behaviour recorded in `docs/provider-notes.md`, not
 * against the OpenAI specification. The quirks it defends against are real and
 * were seen on a live server:
 *   - `delta.content` arrives as `null`, not absent (§5)
 *   - the final chunk has `choices: []` (§5)
 *   - model ids contain spaces and must be URL-encoded (§2)
 *   - `/v1/models` entries embed the upstream command line, including the path
 *     to its API key file, and must never be forwarded (§2, INV-04)
 */
export class LlamaCppProvider implements Provider {
  readonly #config: ProviderConfig;
  readonly #logger: Logger;
  /** Lazily filled; never warmed eagerly, because probing loads models (§3). */
  readonly #contextLengths = new Map<string, number>();
  readonly #policy: HostPolicy;
  readonly #resolver: Resolver | undefined;

  constructor(
    config: ProviderConfig,
    logger: Logger,
    options: { policy?: HostPolicy; resolver?: Resolver } = {}
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#policy = options.policy ?? DEFAULT_HOST_POLICY;
    this.#resolver = options.resolver;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.#config.apiKey !== undefined) {
      headers['Authorization'] = `Bearer ${this.#config.apiKey}`;
    }
    return headers;
  }

  /**
   * Performs a request with a timeout, mapping transport failures to canonical
   * codes. The upstream response body is never attached to the thrown error.
   */
  async #fetch(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
  ): Promise<{ response: UndiciResponse; release: () => void }> {
    const timeout = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = init.signal !== undefined ? AbortSignal.any([init.signal, timeout]) : timeout;

    try {
      // Every outbound request is re-validated and pinned, not just the one
      // that was checked at config load (INV-19).
      return await safeFetch(
        new URL(`${this.#config.baseUrl}${path}`),
        { ...init, signal },
        {
          policy: this.#policy,
          ...(this.#resolver !== undefined ? { resolver: this.#resolver } : {}),
        }
      );
    } catch (err) {
      if (err instanceof SsrfError) {
        this.#logger.warn('Provider endpoint rejected by SSRF policy', { reason: err.reason });
        throw new AppError('ENDPOINT_NOT_ALLOWED', 'That provider endpoint is not permitted.');
      }
      // A caller-initiated abort is not a provider failure; let it propagate so
      // cancellation is not misreported as an upstream error.
      if (init.signal?.aborted === true) throw err;

      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AppError('PROVIDER_TIMEOUT', 'The model provider did not respond in time.');
      }
      this.#logger.warn('Provider unreachable', { path, error: err });
      throw new AppError('PROVIDER_UNAVAILABLE', 'The model provider is unreachable.');
    }
  }

  /**
   * Normalizes an upstream error response. The upstream `message` is read only
   * to classify it, and is never included in what we throw (INV-04).
   */
  async #normalizeError(response: UndiciResponse, model?: string): Promise<AppError> {
    let upstreamType = '';
    let upstreamMessage = '';
    try {
      const body = (await response.json()) as { error?: { type?: string; message?: string } };
      upstreamType = body.error?.type ?? '';
      upstreamMessage = body.error?.message ?? '';
    } catch {
      // Non-JSON body; classification falls back to the status code.
    }

    this.#logger.warn('Provider returned an error', {
      status: response.status,
      upstreamType,
      model,
    });

    if (response.status === 401 || response.status === 403) {
      return new AppError('PROVIDER_ERROR', 'The model provider rejected our credentials.');
    }
    if (upstreamMessage.includes('not found') && upstreamMessage.includes('model')) {
      return new AppError('MODEL_NOT_FOUND', 'The requested model is not available.');
    }
    if (upstreamType === 'exceed_context_size_error') {
      // The upstream body discloses n_ctx and token counts; neither is forwarded.
      return new AppError('PROVIDER_ERROR', 'The request exceeded the model context size.');
    }
    if (response.status >= 500) {
      return new AppError('PROVIDER_ERROR', 'The model provider reported an internal error.');
    }
    return new AppError('PROVIDER_ERROR', 'The model provider rejected the request.');
  }

  async listModels(signal?: AbortSignal): Promise<ModelDto[]> {
    const { response, release } = await this.#fetch('/v1/models', {
      headers: this.#headers(),
      ...(signal !== undefined ? { signal } : {}),
    });

    let body: unknown;
    try {
      if (!response.ok) throw await this.#normalizeError(response);
      body = await response.json();
    } catch (err) {
      release();
      if (err instanceof AppError) throw err;
      throw new AppError('PROVIDER_ERROR', 'The model provider returned an unreadable response.');
    }
    release();

    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new AppError('PROVIDER_ERROR', 'The model provider returned an unexpected response.');
    }

    // Explicit mapping: everything not named here is dropped, including
    // `status.args` and `status.preset` (INV-04).
    const models: ModelDto[] = [];
    for (const candidate of data as unknown[]) {
      // A provider is free to return anything; a null or non-object entry must
      // be skipped rather than crash discovery for every other model.
      if (typeof candidate !== 'object' || candidate === null) continue;
      const raw = candidate as Record<string, unknown>;

      const id = raw['id'];
      if (typeof id !== 'string' || id.length === 0) continue;

      const architecture = raw['architecture'] as { input_modalities?: unknown } | undefined;
      const rawModalities = architecture?.input_modalities;
      const inputModalities: Modality[] = Array.isArray(rawModalities)
        ? rawModalities.filter((m): m is Modality => m === 'text' || m === 'image' || m === 'audio')
        : ['text'];

      const status = raw['status'] as { value?: unknown } | undefined;

      models.push({
        id,
        inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
        loaded: status?.value === 'loaded',
      });
    }

    return models;
  }

  contextLength(model: string): number | null {
    return this.#contextLengths.get(model) ?? null;
  }

  async *streamChat({
    model,
    messages,
    maxOutputTokens,
    signal,
  }: ChatRequest): AsyncIterable<ProviderChunk> {
    const { response, release } = await this.#fetch('/v1/chat/completions', {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        messages: messages.map(({ role, content }: ChatMessage) => ({ role, content })),
        max_tokens: maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!response.ok) {
      const error = await this.#normalizeError(response, model);
      release();
      throw error;
    }
    if (response.body === null) {
      release();
      throw new AppError('PROVIDER_ERROR', 'The model provider returned an empty stream.');
    }

    // undici types the body loosely; the runtime value is a web ReadableStream.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          for (const chunk of this.#parseFrame(frame, model)) {
            yield chunk;
          }
        }
      }
    } finally {
      // Releasing the lock lets the abort actually tear down the socket, and
      // the dispatcher is only closed once the body is finished with.
      reader.cancel().catch(() => undefined);
      release();
    }
  }

  /** Parses one SSE frame into zero or more chunks. Tolerates every shape seen live. */
  *#parseFrame(frame: string, model: string): Generator<ProviderChunk> {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        this.#logger.warn('Provider sent an unparseable stream frame', { model });
        continue;
      }

      const chunk = parsed as {
        choices?: unknown;
        error?: { message?: string };
        usage?: unknown;
      };

      // Mid-stream error frames were never observed live, but are handled
      // rather than silently treated as content (provider notes §6).
      if (chunk.error !== undefined && chunk.error !== null) {
        throw new AppError('PROVIDER_ERROR', 'The model provider failed mid-stream.');
      }

      // The final chunk carries usage with `choices: []` (provider notes §5).
      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;

      const choice = chunk.choices[0] as {
        delta?: { content?: unknown; reasoning_content?: unknown };
        finish_reason?: unknown;
      };

      const reasoning = choice.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        yield { type: 'reasoning', text: reasoning };
      }

      // `content` arrives as `null` on the first chunk (provider notes §5).
      const content = choice.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield { type: 'content', text: content };
      }

      if (typeof choice.finish_reason === 'string') {
        yield { type: 'finish', reason: choice.finish_reason };
      }
    }
  }
}
