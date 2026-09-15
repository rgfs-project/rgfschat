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
  /**
   * An image's area in pixels, when its header could be read.
   *
   * Carried because the budget is decided here and an image's token cost
   * scales with its area, not with its file size — a 6 MP screenshot and a
   * 0.3 MP thumbnail can weigh the same on disk. Absent for anything that is
   * not an image, and for an image whose header did not parse.
   */
  pixels?: number;
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
 * How much of an image one token covers.
 *
 * A vision model cuts an image into fixed patches, so its cost scales with
 * *area*. The Qwen-VL family — the common case on the reference server — uses
 * 28px patches merged 2x2, so one token covers 56x56 = 3136 pixels. Gemma 3
 * lands in the same place by a different route.
 *
 * This replaces a flat per-image estimate, which was the bug: a flat figure is
 * right at one resolution and wrong either side of it, and it was wrong in the
 * dangerous direction. The store accepts images up to 50 MP, which is sixteen
 * thousand tokens of picture charged as twelve hundred — so a screenshot from
 * a high-density display passed the budget check here and was then refused by
 * the provider for exceeding its context, which reaches the reader as a reply
 * that failed with no output and no reason.
 */
const IMAGE_PIXELS_PER_TOKEN = 3_136;

/**
 * What an image costs when its dimensions could not be read, and the floor
 * under every image.
 *
 * Roughly a 1024px square, which is what this estimate was for every image
 * before area was taken into account. As a floor it covers the models that
 * spend a fixed number of tokens on a tile however small the picture is; as a
 * fallback it keeps an unreadable header from being charged nothing at all.
 */
const IMAGE_TOKENS_ESTIMATE = 1_200;

/**
 * What one image costs against the context budget.
 *
 * A documented estimate, as contracts §4 requires, not a measurement: the true
 * cost depends on the model's patch size and on how it tiles, and the only way
 * to learn it is to send the image and read `usage` back — by which point the
 * budget decision has already been made. Erring high is the safe direction,
 * since the consequence of guessing low is a request the provider refuses
 * outright.
 */
export function imageTokens(pixels: number | undefined): number {
  if (pixels === undefined || !Number.isFinite(pixels) || pixels <= 0) {
    return IMAGE_TOKENS_ESTIMATE;
  }
  return Math.max(IMAGE_TOKENS_ESTIMATE, Math.ceil(pixels / IMAGE_PIXELS_PER_TOKEN));
}

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

/**
 * What one message costs against the budget.
 *
 * `imageCosts` carries what the images in this message were charged, in the
 * order their parts appear. It has to be passed alongside rather than read off
 * the parts themselves: a content part is the provider's wire shape, and a
 * field added to it for our arithmetic would be sent upstream along with the
 * rest of the request.
 */
function costOf(message: ChatMessage, imageCosts: readonly number[] = []): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  let total = MESSAGE_OVERHEAD_TOKENS;
  let image = 0;
  for (const part of message.content) {
    if (part.type === 'text') total += estimateTokens(part.text);
    else if (part.type === 'image_url') {
      total += imageCosts[image] ?? IMAGE_TOKENS_ESTIMATE;
      image += 1;
    } else total += AUDIO_TOKENS_ESTIMATE;
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
  /* What each turn's images were charged, kept beside the wire shape rather
     than on it — see `costOf`. */
  const costs = new Map<ChatMessage, number[]>();
  const costFor = (message: ChatMessage): number => costOf(message, costs.get(message));

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
      const { message: turn, imageCosts } = userMessage(message.body, message.attachments ?? [], {
        attachments,
        modalities,
      });
      turns.push(turn);
      if (imageCosts.length > 0) costs.set(turn, imageCosts);
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
  const floor = systemCost + (newest !== undefined ? costFor(newest) : 0);
  if (floor > budget) {
    throw new AppError('CONTEXT_TOO_LARGE', 'This message is too large for the selected model.');
  }

  // Keep the newest turns and walk backwards while they fit; whole messages only.
  const kept: ChatMessage[] = [];
  let used = systemCost;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const message = turns[i] as ChatMessage;
    const cost = costFor(message);
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
/** What an attachment-only turn says to the provider, and nowhere else. */
export const PROMPT_FOR_MEDIA_ONLY = 'Please look at the attached file.';

function userMessage(
  body: string,
  ids: readonly string[],
  options: {
    attachments: ReadonlyMap<string, ResolvedAttachment> | undefined;
    modalities: readonly string[];
  }
): { message: ChatMessage; imageCosts: number[] } {
  const resolved = ids
    .map((id) => options.attachments?.get(id))
    .filter((found): found is ResolvedAttachment => found !== undefined);

  if (resolved.length === 0) return { message: { role: 'user', content: body }, imageCosts: [] };

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

  if (media.length === 0) return { message: { role: 'user', content: text }, imageCosts: [] };

  /*
   * A neutral part when the reader wrote nothing.
   *
   * An attachment-only turn has an empty body, and several OpenAI-compatible
   * servers reject a text part that is empty — or, worse, accept it and answer
   * as though nothing was asked. This says what the turn means, in the request
   * only: it is never persisted and never shown, so the transcript still holds
   * exactly what the reader sent, which is the picture and no words.
   */
  const parts: ContentPart[] = [
    { type: 'text', text: text === '' ? PROMPT_FOR_MEDIA_ONLY : text },
    ...media.map((attachment): ContentPart =>
      attachment.kind === 'image'
        ? { type: 'image_url', image_url: { url: attachment.content } }
        : {
            type: 'input_audio',
            input_audio: { data: attachment.content, format: formatOf(attachment.mediaType) },
          }
    ),
  ];
  return {
    message: { role: 'user', content: parts },
    imageCosts: media
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => imageTokens(attachment.pixels)),
  };
}

/** Re-exported so callers can measure a message the way the budget does. */
export function messageText(message: ChatMessage): string {
  return textOf(message.content);
}
