import type { ChatMessage, ModelDto, Modality, SamplerSettings } from '@shared/generation.ts';
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
/**
 * The sampling a model's own llama-server process was launched with.
 *
 * Router mode reports each model's command line on `/v1/models`, which costs
 * nothing — the alternative, `GET /props?model=<id>`, *loads the model and
 * evicts the resident one* (provider notes §3), so it must never be used for
 * something as incidental as showing a default.
 *
 * Only the sampling flags are read. The rest of the command line is dropped
 * unparsed, and the raw array never leaves this function: it contains
 * `--api-key-file` and the model's path on disk (INV-04).
 */
function parseLaunchSampler(args: unknown): SamplerSettings | undefined {
  if (!Array.isArray(args)) return undefined;
  // The provider can return anything; narrow before reading pairs out of it.
  const parts: unknown[] = args;

  const flags = new Map<string, string>();
  for (let i = 0; i < parts.length - 1; i += 1) {
    const flag = parts[i];
    const value = parts[i + 1];
    if (typeof flag === 'string' && flag.startsWith('--') && typeof value === 'string') {
      flags.set(flag, value);
    }
  }

  const num = (...names: string[]): number | undefined => {
    for (const name of names) {
      const raw = flags.get(name);
      if (raw === undefined) continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };

  const sampler: SamplerSettings = {
    temperature: num('--temperature', '--temp'),
    topP: num('--top-p'),
    topK: num('--top-k'),
    minP: num('--min-p'),
    repeatPenalty: num('--repeat-penalty'),
  };

  // Nothing recognised is better reported as absent than as an object of
  // undefineds, so a caller can tell "no information" from "all defaults".
  return Object.values(sampler).some((value) => value !== undefined) ? sampler : undefined;
}

/**
 * Sampler settings in OpenAI-compatible spelling.
 *
 * Only fields that are actually set are emitted. Sending `temperature: null`
 * or a default of our own choosing would override whatever the llama-server
 * operator configured, which is the opposite of leaving a model alone.
 */
function samplerBody(sampler: SamplerSettings | undefined): Record<string, number> {
  if (sampler === undefined) return {};

  const body: Record<string, number> = {};
  if (sampler.temperature !== undefined) body['temperature'] = sampler.temperature;
  if (sampler.topP !== undefined) body['top_p'] = sampler.topP;
  if (sampler.topK !== undefined) body['top_k'] = sampler.topK;
  if (sampler.minP !== undefined) body['min_p'] = sampler.minP;
  if (sampler.repeatPenalty !== undefined) body['repeat_penalty'] = sampler.repeatPenalty;
  return body;
}

/**
 * How many calls one reply may ask for, and how long their arguments may run.
 *
 * Both are bounds on what the *provider* can make this process hold, in the
 * same spirit as the response byte cap: a generation asks for at most a handful
 * of memory operations, and a few kilobytes of arguments is already far more
 * than the 8KB a single memory may contain.
 */
const MAX_TOOL_CALLS = 16;
const MAX_TOOL_ARGUMENT_CHARS = 16_384;

/** One call mid-flight. `overflow` outlives a truncation, so it stays refused. */
interface PartialToolCall {
  id: string;
  name: string;
  args: string;
  overflow: boolean;
}

export class LlamaCppProvider implements Provider {
  readonly #config: ProviderConfig;
  readonly #logger: Logger;
  /** Lazily filled; never warmed eagerly, because probing loads models (§3). */
  readonly #contextLengths = new Map<string, number>();
  readonly #policy: HostPolicy;
  readonly #resolver: Resolver | undefined;
  readonly #maxResponseBytes: number;

  constructor(
    config: ProviderConfig,
    logger: Logger,
    options: { policy?: HostPolicy; resolver?: Resolver; maxResponseBytes?: number } = {}
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#policy = options.policy ?? DEFAULT_HOST_POLICY;
    this.#resolver = options.resolver;
    /*
     * 64 MB is far beyond any reply a context window can produce — a 128k
     * context is a few hundred kilobytes of text — and far below what an
     * unbounded stream costs. Generous on purpose: this is a backstop against
     * a provider behaving pathologically, not a second output limit.
     */
    this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
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

      const status = raw['status'] as { value?: unknown; args?: unknown } | undefined;
      // Parsed here and discarded; `args` itself is never carried forward.
      const defaults = parseLaunchSampler(status?.args);

      models.push({
        id,
        inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
        loaded: status?.value === 'loaded',
        ...(defaults === undefined ? {} : { defaults }),
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
    sampler,
    tools,
    signal,
  }: ChatRequest): AsyncIterable<ProviderChunk> {
    const { response, release } = await this.#fetch('/v1/chat/completions', {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        messages: messages.map(({ role, content, toolCalls, toolCallId }: ChatMessage) => ({
          role,
          content,
          // Sent in the shape upstream emitted them, so a continuation turn
          // refers to the same calls by the same ids.
          ...(toolCalls === undefined
            ? {}
            : {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }),
          ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
        })),
        max_tokens: maxOutputTokens,
        ...samplerBody(sampler),
        // Omitted entirely when there are none: see `ChatRequest.tools`.
        ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
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
    let received = 0;
    /*
     * Calls under construction, addressed by the `index` upstream gives them.
     *
     * Local to this call rather than an instance field: one provider serves
     * every concurrent generation, and a shared accumulator would splice two
     * readers' arguments into one another's calls.
     */
    const pending = new Map<number, PartialToolCall>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        /*
         * A cap on what one generation may stream back.
         *
         * The provider is configured by an administrator and reached over the
         * network, which makes it something this process trusts but cannot
         * control: a compromised or simply broken one can stream without end,
         * and every byte is accumulated in memory and checkpointed to disk.
         * The reply is bounded by `maxOutputTokens` in the *request*, and this
         * is the matching bound on the answer — a limit that only the polite
         * case observes is not a limit.
         */
        received += value.byteLength;
        if (received > this.#maxResponseBytes) {
          throw new AppError(
            'PROVIDER_ERROR',
            'The model provider sent more data than this server will accept.'
          );
        }

        buffer += decoder.decode(value, { stream: true });

        /*
         * A frame that never ends is the same attack without the byte count:
         * a stream of data with no blank line accumulates in `buffer`
         * untouched by the loop below. Bounded at the same order as the cap.
         */
        if (buffer.length > this.#maxResponseBytes) {
          throw new AppError('PROVIDER_ERROR', 'The model provider sent a malformed response.');
        }

        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          for (const chunk of this.#parseFrame(frame, model, pending)) {
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

  /**
   * Parses one SSE frame into zero or more chunks. Tolerates every shape seen live.
   *
   * `pending` carries calls part-way through arriving; it belongs to the
   * caller's stream and is mutated here rather than returned, because a frame
   * can contain a fragment of a call that several later frames also add to.
   */
  *#parseFrame(
    frame: string,
    model: string,
    pending: Map<number, PartialToolCall>
  ): Generator<ProviderChunk> {
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
        delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
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

      this.#accumulateToolCalls(choice.delta?.tool_calls, pending, model);

      if (typeof choice.finish_reason === 'string') {
        /*
         * Calls are flushed ahead of the finish, so a consumer that stops
         * reading at `finish` still sees them. Sorted by the index upstream
         * assigned rather than by insertion, since a fragment for index 1 can
         * arrive before index 0 has its name.
         */
        for (const index of [...pending.keys()].sort((a, b) => a - b)) {
          const call = pending.get(index) as PartialToolCall;
          // A call upstream never named is not a call, and one whose arguments
          // ran past the cap was truncated — emitting either would push a
          // guaranteed validation failure downstream.
          if (call.name === '' || call.overflow) continue;
          yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: call.args } };
        }
        pending.clear();

        yield { type: 'finish', reason: choice.finish_reason };
      }
    }
  }

  /**
   * Folds one frame's `tool_calls` fragments into the calls being built.
   *
   * Upstream dictates a call across many frames: the first carries `id` and
   * `function.name`, and the rest append to `function.arguments` a few
   * characters at a time. Fragments are addressed by `index`, which is the only
   * thing tying them together — `id` is absent from every fragment after the
   * first.
   *
   * Everything here is defensive for the reason the byte cap above is: the
   * provider is configured by an administrator and reached over the network, so
   * it is trusted to be *theirs* but not to be well-behaved. A malformed
   * fragment is dropped rather than throwing, since a broken call should cost
   * the call and not the reply that was streamed alongside it.
   */
  #accumulateToolCalls(raw: unknown, pending: Map<number, PartialToolCall>, model: string): void {
    if (!Array.isArray(raw)) return;

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;

      const fragment = entry as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };

      // `index` is what threads fragments together, so one without it cannot be
      // attributed to a call at all. Defaulted to 0 because a provider emitting
      // a single call sometimes omits it entirely.
      const index = typeof fragment.index === 'number' ? fragment.index : 0;
      if (!Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS) {
        this.#logger.warn('Provider sent a tool call fragment with an unusable index', { model });
        continue;
      }

      const call = pending.get(index) ?? { id: '', name: '', args: '', overflow: false };

      if (typeof fragment.id === 'string' && fragment.id !== '') call.id = fragment.id;
      const name = fragment.function?.name;
      if (typeof name === 'string' && name !== '') call.name = name;

      const args = fragment.function?.arguments;
      if (typeof args === 'string' && args !== '') {
        /*
         * Bounded like the stream itself. Arguments are accumulated in memory
         * and handed on to a JSON parser, and a provider that never stops
         * appending would otherwise be limited only by the total response cap —
         * which is orders of magnitude more than any real call needs.
         */
        if (call.args.length + args.length > MAX_TOOL_ARGUMENT_CHARS) {
          /*
           * Marked rather than deleted. Deleting it would let the next fragment
           * for this index start a fresh call from the middle of the arguments
           * of the one just refused, which is how a discard turns into a
           * plausible-looking call nobody asked for.
           */
          if (!call.overflow) {
            this.#logger.warn('Discarding an oversized tool call from the provider', {
              model,
              index,
            });
          }
          call.overflow = true;
          pending.set(index, call);
          continue;
        }
        call.args += args;
      }

      pending.set(index, call);
    }
  }
}
