import { textOf, type ChatMessage, type ContentPart } from '@shared/generation.ts';
import { REQUIRED_MODALITY, type AttachmentKind } from '@shared/attachment.ts';
import type { Conversation } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';

/**
 * Server-side prompt assembly from canonical storage (contracts §4).
 *
 * The client never sends history — only the new user message, which is already
 * persisted by the time this runs. Everything here is read back from the
 * Markdown, so what the model sees is exactly what is on disk.
 */

/**
 * An attachment, resolved for the prompt.
 *
 * Resolution happens before assembly rather than inside it: assembly is pure
 * and synchronous, and reading files from it would make the budget arithmetic
 * depend on the filesystem. An attachment the store could not produce is simply
 * absent from this map, which is what turns a missing file into a skipped part
 * rather than a failed generation.
 */
export interface ResolvedAttachment {
  id: string;
  filename: string;
  kind: AttachmentKind;
  mediaType: string;
  /**
   * Text content already truncated; a `data:` URL for an image; bare base64
   * for audio. Three shapes because the three content parts want three
   * different things, and converting between them at the point of use would
   * mean every caller knowing which is which.
   */
  content: string;
  /** Whether the text was cut short, so the marker can say so. */
  truncated: boolean;
}

export interface BudgetOptions {
  /** Administrator-configured, prepended ahead of the conversation's own. */
  systemPrompt?: string | undefined;
  /** The model's real context length when known, else `DEFAULT_CONTEXT_TOKENS`. */
  contextTokens: number;
  /** Reserved for the reply; subtracted from the context to get the input budget. */
  maxOutputTokens: number;
  /** Resolved attachments by id. Absent ones are skipped, not fatal. */
  attachments?: ReadonlyMap<string, ResolvedAttachment>;
  /**
   * What the chosen model can actually take in.
   *
   * Only consulted for attachments already in the conversation's history. A
   * *new* message carrying one the model cannot read is refused before
   * anything is persisted, by the caller — reaching this point means the
   * attachment belongs to an older turn, and dropping it silently is better
   * than refusing to continue a conversation because of a picture three
   * questions ago.
   */
  modalities?: readonly string[];
}

/**
 * Conservative token estimate: at least 1 token per 3 bytes (contracts §4).
 *
 * A real tokenizer is available upstream, but on a router-mode llama.cpp server
 * `/tokenize` requires a `model` and triggers a model load, evicting whatever is
 * resident (see docs/provider-notes.md §3-4). Paying a model swap to count
 * tokens would be far more expensive than over-reserving, so the estimate is
 * used and deliberately errs high.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/** Per-message overhead for role framing and separators, charged conservatively. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * What an image costs against the context budget.
 *
 * A documented estimate, as contracts §4 requires, not a measurement: the true
 * cost depends on the model's patch size and on how it tiles an image, and the
 * only way to learn it is to send the image and read `usage` back — by which
 * point the budget decision has already been made. 1200 is roughly a 1024px
 * square at common patch sizes, and erring high is the safe direction: the
 * consequence of guessing low is a request the provider refuses outright.
 */
const IMAGE_TOKENS_ESTIMATE = 1_200;

/**
 * What a clip of audio costs, as an estimate for the same reason.
 *
 * Audio encoders work in frames of a fixed duration, so cost scales with
 * length rather than with bytes — but length is not known without decoding,
 * which is the provider's job. This is a flat reservation on the same
 * err-high principle: refusing a request is cheaper than having one refused.
 */
const AUDIO_TOKENS_ESTIMATE = 2_000;

/** The `format` an audio part carries. Upstream ignores it; clients read it. */
function formatOf(mediaType: string): string {
  if (mediaType === 'audio/mpeg') return 'mp3';
  if (mediaType === 'audio/flac') return 'flac';
  return 'wav';
}

function costOf(message: ChatMessage): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const part of message.content) {
    if (part.type === 'text') total += estimateTokens(part.text);
    else if (part.type === 'image_url') total += IMAGE_TOKENS_ESTIMATE;
    else total += AUDIO_TOKENS_ESTIMATE;
  }
  return total;
}

export interface AssembledPrompt {
  messages: ChatMessage[];
  /** How many non-system messages were dropped to fit the budget. */
  dropped: number;
  estimatedTokens: number;
}

/**
 * Builds the message list for a generation.
 *
 * Order and inclusion rules (contracts §4):
 *   1. every `system` message, in file order;
 *   2. `user` and `assistant` bodies in order;
 *   3. reasoning is **never** sent back to the model;
 *   4. assistant messages with an empty body are skipped — a failed generation
 *      writes one, and replaying it would teach the model to answer with silence.
 *
 * If the budget is exceeded, the oldest non-system messages are dropped whole
 * until it fits. The newest user message is never dropped; if the system
 * messages plus that message alone do not fit, the request fails with
 * `CONTEXT_TOO_LARGE` before the provider is called.
 */
export function assemblePrompt(
  conversation: Conversation,
  { contextTokens, maxOutputTokens, systemPrompt, attachments, modalities = [] }: BudgetOptions
): AssembledPrompt {
  const system: ChatMessage[] = [];
  const turns: ChatMessage[] = [];

  /*
   * The administrator's prompt for this model leads, ahead of anything in the
   * conversation itself.
   *
   * It joins the `system` list rather than being bolted on afterwards so it is
   * charged against the budget like every other system message. Appended after
   * assembly it would be free, and a long enough one would silently push the
   * request over the context window it was measured against.
   */
  if (systemPrompt !== undefined && systemPrompt.trim() !== '') {
    system.push({ role: 'system', content: systemPrompt });
  }

  for (const message of conversation.messages) {
    if (message.type === 'system') {
      system.push({ role: 'system', content: message.body });
      continue;
    }
    if (message.type === 'user') {
      turns.push(userMessage(message.body, message.attachments ?? [], { attachments, modalities }));
      continue;
    }
    // Assistant: body only. `reasoning` is intentionally not read here.
    if (message.body !== '') {
      turns.push({ role: 'assistant', content: message.body });
    }
  }

  const budget = contextTokens - maxOutputTokens;
  if (budget <= 0) {
    throw new AppError(
      'CONTEXT_TOO_LARGE',
      'The reserved output size leaves no room for the conversation.'
    );
  }

  const systemCost = system.reduce((total, message) => total + costOf(message), 0);
  const newest = turns.at(-1);

  // The newest user message is mandatory, so it and the system messages set the
  // floor. If that alone does not fit, nothing can be dropped to help.
  const floor = systemCost + (newest !== undefined ? costOf(newest) : 0);
  if (floor > budget) {
    throw new AppError('CONTEXT_TOO_LARGE', 'This message is too large for the selected model.');
  }

  // Keep the newest turns and walk backwards while they fit; whole messages only.
  const kept: ChatMessage[] = [];
  let used = systemCost;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const message = turns[i] as ChatMessage;
    const cost = costOf(message);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(message);
  }

  return {
    messages: [...system, ...kept],
    dropped: turns.length - kept.length,
    estimatedTokens: used,
  };
}

/**
 * A user turn, with whatever it carried.
 *
 * Text attachments are inlined as fenced blocks labelled with their filename,
 * because that is the only way a model can read them and it keeps the prompt a
 * single readable document. Images become content parts, and only when the
 * model can see — an image sent to a model without a projector is a 500 from
 * the provider (docs/provider-notes.md §9), so a history containing one must
 * not be able to break every later message in the conversation.
 *
 * An attachment that is missing from the map is skipped. A file can be deleted
 * out from under a message, and a conversation that can no longer be continued
 * because of it would be a worse outcome than one that continues without it
 * (contracts §7).
 */
function userMessage(
  body: string,
  ids: readonly string[],
  options: {
    attachments: ReadonlyMap<string, ResolvedAttachment> | undefined;
    modalities: readonly string[];
  }
): ChatMessage {
  const resolved = ids
    .map((id) => options.attachments?.get(id))
    .filter((found): found is ResolvedAttachment => found !== undefined);

  if (resolved.length === 0) return { role: 'user', content: body };

  const texts = resolved.filter((attachment) => attachment.kind === 'text');
  const media = resolved.filter(
    (attachment) =>
      attachment.kind !== 'text' &&
      options.modalities.includes(REQUIRED_MODALITY[attachment.kind] ?? '')
  );

  const inlined = texts.map((attachment) => {
    const marker = attachment.truncated ? '\n\n[truncated]' : '';
    return `Attached file: ${attachment.filename}\n\n\u0060\u0060\u0060\n${attachment.content}${marker}\n\u0060\u0060\u0060`;
  });

  const text = [body, ...inlined].filter((part) => part !== '').join('\n\n');

  if (media.length === 0) return { role: 'user', content: text };

  const parts: ContentPart[] = [
    { type: 'text', text },
    ...media.map((attachment): ContentPart =>
      attachment.kind === 'image'
        ? { type: 'image_url', image_url: { url: attachment.content } }
        : {
            type: 'input_audio',
            input_audio: { data: attachment.content, format: formatOf(attachment.mediaType) },
          }
    ),
  ];
  return { role: 'user', content: parts };
}

/** Re-exported so callers can measure a message the way the budget does. */
export function messageText(message: ChatMessage): string {
  return textOf(message.content);
}
