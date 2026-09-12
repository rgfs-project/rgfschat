import type { ChatMessage, ModelDto, SamplerSettings } from '@shared/generation.ts';

/** A single piece of a streamed completion. Reasoning is deliberately distinct. */
export type ProviderChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'finish'; reason: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /**
   * Administrator-configured sampling, or nothing.
   *
   * Only the fields that are set are sent upstream, so a model with no
   * configuration behaves exactly as it did before this existed rather than
   * being handed our guesses at sensible defaults.
   */
  sampler?: SamplerSettings;
  /** Aborting this signal must terminate the upstream request promptly. */
  signal: AbortSignal;
}

/**
 * The minimum a generation needs. Deliberately not a general-purpose OpenAI
 * client: Phase 5 adds more providers behind this same interface, so anything
 * llama.cpp-specific stays in the implementation.
 */
export interface Provider {
  listModels(signal?: AbortSignal): Promise<ModelDto[]>;

  /** Streams a completion. Throws a normalized `AppError` on any upstream failure. */
  streamChat(request: ChatRequest): AsyncIterable<ProviderChunk>;

  /**
   * Context window for a model, or `null` when not discoverable without cost.
   * Implementations must not trigger expensive work here — on a router-mode
   * llama.cpp server, probing `/props` loads the model (provider notes §3).
   */
  contextLength(model: string): number | null;
}
