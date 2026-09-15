import type {
  ChatMessage,
  ModelDto,
  SamplerSettings,
  ToolCall,
  ToolDefinition,
} from '@shared/generation.ts';

/** A single piece of a streamed completion. Reasoning is deliberately distinct. */
export type ProviderChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  /**
   * A whole call, emitted once upstream has finished dictating it.
   *
   * Reassembly happens inside the provider rather than here because it is a
   * wire-format concern: OpenAI streams a call as fragments addressed by
   * `index`, with the name in one chunk and the arguments dribbled across
   * many. Every consumer downstream wants the finished call, and none of them
   * should have to know how it arrived.
   */
  | { type: 'tool_call'; call: ToolCall }
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
  /**
   * Functions the model may ask for, or nothing.
   *
   * Absent means the `tools` key is not sent at all rather than sent empty.
   * llama.cpp builds differ in how they treat an empty array — some refuse the
   * request outright — and a model with nothing to call should see exactly the
   * request it saw before this existed.
   */
  tools?: readonly ToolDefinition[];
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
