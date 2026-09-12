/**
 * Generation and model DTOs shared by client and server.
 *
 * These are the *only* shapes that cross the wire. Provider payloads are mapped
 * into them and the remainder is discarded — `/v1/models` entries in particular
 * carry the upstream command line, including the path to its API key file
 * (see `docs/provider-notes.md` §2), which must never reach the browser (INV-04).
 */

export type Modality = 'text' | 'image' | 'audio';

export interface ModelDto {
  /** Opaque provider id. May contain spaces — see provider notes §2. */
  id: string;
  inputModalities: Modality[];
  /** Whether the provider currently holds this model in memory. Advisory only. */
  loaded: boolean;
  /**
   * The sampling the provider itself was launched with, where it reports it.
   *
   * Advisory: it tells an administrator what a model does when nothing is
   * configured here, so "reset to defaults" can show what it is resetting *to*
   * rather than an empty slider.
   */
  defaults?: SamplerSettings;
}

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

/**
 * `pending → streaming → (completed | cancelled | failed | timed_out)`.
 * Exactly one terminal state is ever reached (INV-05).
 */
export const GENERATION_STATES = [
  'pending',
  'streaming',
  'completed',
  'cancelled',
  'failed',
  'timed_out',
] as const;

export type GenerationState = (typeof GENERATION_STATES)[number];

export const TERMINAL_STATES = ['completed', 'cancelled', 'failed', 'timed_out'] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: GenerationState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** `GET /api/generations/:id` — the full current picture, safe to poll or resume from. */
export interface GenerationSnapshotDto {
  generationId: string;
  assistantMessageId: string;
  model: string;
  state: GenerationState;
  content: string;
  /** Kept separate from content everywhere (contracts §4: never sent back to the model). */
  reasoning: string;
  /** Set only in a terminal state, and only when the generation failed. */
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  /** Id of the last event emitted, so a client can tell how far it has seen. */
  lastEventId: number;
  /** Which provider produced it, for reconnection and display. */
  providerId: string;
}

/** `POST /api/generations` → 202. All three ids are minted server-side. */
export interface GenerationAcceptedDto {
  generationId: string;
  /** The user message, already durable before this is returned (INV-08). */
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * SSE event payloads. The event name is carried in the SSE `event:` field and
 * every event has a monotonically increasing `id:` (contracts §5).
 */
export type GenerationEvent =
  | { type: 'snapshot'; snapshot: GenerationSnapshotDto }
  /**
   * Sent when a reconnecting client's `Last-Event-ID` is outside the replay
   * window, or unrecognised. It carries the full state so the client can
   * discard what it had and continue — never a silent gap (INV-20).
   */
  | { type: 'resync'; snapshot: GenerationSnapshotDto }
  | { type: 'content'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'state'; state: GenerationState }
  | { type: 'done'; state: GenerationState; errorCode?: string };

/**
 * Per-model sampler settings.
 *
 * Every field is optional and an absent one is *not sent upstream at all*, so
 * the provider's own default applies. That matters: llama.cpp's defaults vary
 * by build and by model, and writing our own guesses into every request would
 * silently override whatever the server operator configured.
 */
export interface SamplerSettings {
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  minP?: number | undefined;
  repeatPenalty?: number | undefined;
  /** Prepended to every conversation with this model. */
  systemPrompt?: string | undefined;
}

/** The bounds the UI offers and the server enforces. */
export const SAMPLER_LIMITS = {
  temperature: { min: 0, max: 2, step: 0.05 },
  topP: { min: 0, max: 1, step: 0.01 },
  topK: { min: 0, max: 100, step: 1 },
  minP: { min: 0, max: 1, step: 0.01 },
  repeatPenalty: { min: 1, max: 2, step: 0.01 },
} as const;

export const SYSTEM_PROMPT_MAX_LENGTH = 8_000;
