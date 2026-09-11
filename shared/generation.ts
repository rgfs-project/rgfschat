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
}

/** `POST /api/generations` → 202. */
export interface GenerationAcceptedDto {
  generationId: string;
  assistantMessageId: string;
}

/**
 * SSE event payloads. The event name is carried in the SSE `event:` field and
 * every event has a monotonically increasing `id:` (contracts §5).
 */
export type GenerationEvent =
  | { type: 'snapshot'; snapshot: GenerationSnapshotDto }
  | { type: 'content'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'state'; state: GenerationState }
  | { type: 'done'; state: GenerationState; errorCode?: string };
