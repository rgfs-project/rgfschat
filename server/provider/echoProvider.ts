import type { ModelDto } from '@shared/generation.ts';
import { AppError } from '../errors/AppError.ts';
import type { ChatRequest, Provider, ProviderChunk } from './types.ts';

/**
 * A second, deliberately non-HTTP `Provider` implementation.
 *
 * Its only job is to prove the abstraction is real. `LlamaCppProvider` is the
 * only production implementation, so without a second one it is impossible to
 * tell whether the interface describes "what generation needs" or merely "what
 * llama.cpp happens to do". This one holds its models in memory, streams from a
 * function, and never opens a socket — if generation still works against it,
 * nothing llama.cpp-shaped has leaked upward.
 */
export interface EchoProviderOptions {
  name?: string;
  models?: ModelDto[];
  /** Produces the reply for a request; defaults to echoing the last message. */
  reply?: (request: ChatRequest) => { reasoning?: string; content: string };
  /** Fail discovery, to exercise the stale-list policy. */
  failListModels?: boolean;
  contextTokens?: number;
  chunkDelayMs?: number;
}

export class EchoProvider implements Provider {
  readonly name: string;
  readonly #models: ModelDto[];
  readonly #reply: NonNullable<EchoProviderOptions['reply']>;
  readonly #contextTokens: number | null;
  readonly #chunkDelayMs: number;
  #failListModels: boolean;
  /** Counts discovery calls, so tests can assert caching actually caches. */
  listModelsCalls = 0;

  constructor(options: EchoProviderOptions = {}) {
    this.name = options.name ?? 'echo';
    this.#models = options.models ?? [
      { id: 'echo-small', inputModalities: ['text'], loaded: true },
      { id: 'echo-large', inputModalities: ['text', 'image'], loaded: false },
    ];
    this.#reply =
      options.reply ??
      ((request) => ({ content: `echo: ${request.messages.at(-1)?.content ?? ''}` }));
    this.#failListModels = options.failListModels ?? false;
    this.#contextTokens = options.contextTokens ?? null;
    this.#chunkDelayMs = options.chunkDelayMs ?? 0;
  }

  /** Lets a test flip a healthy provider to failing mid-run. */
  setFailing(failing: boolean): void {
    this.#failListModels = failing;
  }

  listModels(): Promise<ModelDto[]> {
    this.listModelsCalls += 1;
    if (this.#failListModels) {
      return Promise.reject(new AppError('PROVIDER_UNAVAILABLE', 'Echo provider is down.'));
    }
    return Promise.resolve(this.#models.map((model) => ({ ...model })));
  }

  contextLength(): number | null {
    return this.#contextTokens;
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderChunk> {
    if (!this.#models.some((model) => model.id === request.model)) {
      throw new AppError('MODEL_NOT_FOUND', 'Unknown model for the echo provider.');
    }

    const { reasoning, content } = this.#reply(request);

    if (reasoning !== undefined) {
      yield { type: 'reasoning', text: reasoning };
    }
    for (const word of content.split(/(?<= )/)) {
      if (request.signal.aborted) return;
      if (this.#chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#chunkDelayMs));
      }
      yield { type: 'content', text: word };
    }
    yield { type: 'finish', reason: 'stop' };
  }
}
