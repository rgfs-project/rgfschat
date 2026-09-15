/**
 * Conversation model — `formatVersion: 2` (contracts §3).
 *
 * The shape was meant to be frozen once Phase 3 shipped, with every field a
 * later phase needs defined up front so nothing would require a version bump.
 * Per-message `createdAt` was the one field that plan missed: `formatVersion:
 * 1` predates it. The parser still reads `1` — those messages simply carry no
 * `createdAt` — but every conversation it writes back out, and every new one,
 * is `2`.
 */

export const FORMAT_VERSION = 2;
/** The oldest file shape the parser still accepts, for the reason above. */
export const MIN_READABLE_FORMAT_VERSION = 1;

export const MESSAGE_STATUSES = [
  'complete',
  'cancelled',
  'failed',
  'timed_out',
  'interrupted',
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface SystemMessage {
  type: 'system';
  id: string;
  body: string;
}

export interface UserMessage {
  type: 'user';
  id: string;
  /** 1–10 canonical UUIDs. Parsed and validated from Phase 3; used from Phase 11. */
  attachments?: string[];
  /** Absent on a message written under `formatVersion: 1`, before this existed. */
  createdAt?: string;
  body: string;
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  status: MessageStatus;
  provider?: string;
  model?: string;
  /**
   * The `cc:reasoning` block that precedes this assistant block in the file.
   *
   * Modelled as a field rather than a separate message because the contract
   * requires a reasoning block to be *immediately* followed by the assistant
   * block sharing its id, with at most one per assistant. Making it a field
   * means those two rules cannot be violated by construction, and reasoning can
   * never be mistaken for a message to send back to the model (contracts §4).
   */
  reasoning?: string;
  /** Absent on a message written under `formatVersion: 1`, before this existed. */
  createdAt?: string;
  body: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage;

export interface Conversation {
  formatVersion: typeof FORMAT_VERSION;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

/** Default title for a new conversation (contracts §3.3). */
export const DEFAULT_TITLE = 'New conversation';

export const TITLE_MAX_LENGTH = 200;
/** Auto-derived titles are truncated to this length at a word boundary. */
export const AUTO_TITLE_MAX_LENGTH = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Canonical lowercase UUID, per contracts §1. */
export function isCanonicalUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `YYYY-MM-DDTHH:mm:ss.sssZ` in UTC, and an actually valid instant. */
export function isCanonicalTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function isValidTitle(value: string): boolean {
  return value.length >= 1 && value.length <= TITLE_MAX_LENGTH && !/[\r\n]/.test(value);
}

/**
 * Derives a title from the first user message: truncated to 60 characters at a
 * word boundary (contracts §3.3).
 */
export function deriveTitle(firstUserMessage: string): string {
  const collapsed = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return DEFAULT_TITLE;
  if (collapsed.length <= AUTO_TITLE_MAX_LENGTH) return collapsed;

  const clipped = collapsed.slice(0, AUTO_TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  // Fall back to a hard cut when the first word alone is longer than the limit.
  const cut = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return cut.trimEnd();
}
