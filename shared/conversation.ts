/**
 * Conversation model — `formatVersion: 1` (contracts §3).
 *
 * The shape was meant to be frozen once Phase 3 shipped, with every field a
 * later phase needs defined up front so nothing would require a version bump.
 * Per-message time was the one field that plan missed, and it was added twice
 * in parallel: once as an optional `time` attribute at version 1, and once as
 * `createdAt` behind a bump to version 2. Neither is wrong, and files of both
 * shapes exist.
 *
 * So the reader takes both and the writer picks one. `time` at version 1 is
 * what is written: an optional attribute needs no bump to be added, and a file
 * this app writes stays readable by a build that predates the argument.
 * `createdAt` and version 2 are accepted on the way in and migrate to `time`
 * the next time the conversation is written.
 */

export const FORMAT_VERSION = 1;
/** The newest file shape the parser still accepts, for the reason above. */
export const MAX_READABLE_FORMAT_VERSION = 2;

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
  /**
   * When the message was sent, as a canonical timestamp.
   *
   * Optional because conversations written before it existed have no such
   * attribute, and a file that parsed yesterday has to parse today. A message
   * without one is shown without a time rather than with a guessed one. Read
   * from `createdAt` as well, which is what the same field was called in the
   * parallel implementation of it.
   */
  time?: string;
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
  /** When the reply was written, as a canonical timestamp. Optional, as on a user message. */
  time?: string;
  /**
   * Why this reply did not complete, as an error code from the contract's table.
   *
   * Only meaningful alongside a non-`complete` status, and optional even then:
   * every reply written before this existed has none, and a run can fail for a
   * reason the server could not classify. Without it a failed reply reads as
   * "Failed" forever — the server classifies the failure and logs it, but the
   * person looking at the transcript is not the one who can read the log.
   */
  error?: string;
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
/**
 * Whether a turn has anything in it at all.
 *
 * The one rule, in one place, because it is checked twice: the composer decides
 * whether Send does anything, and the route decides whether to believe the
 * request. Two spellings of it is how a Send button came to be enabled for a
 * message the server would refuse — and how an attachment with nothing typed
 * beside it did nothing at all when clicked.
 *
 * A picture is a message. Requiring words beside it meant typing something
 * meaningless, which was then shown under the image and used as the
 * conversation's title.
 */
export function hasSendableContent(content: string, attachmentIds: readonly unknown[]): boolean {
  return content.trim() !== '' || attachmentIds.length > 0;
}

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
