import type { ChatMessage } from '@shared/generation.ts';
import type { Conversation } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';

/**
 * Server-side prompt assembly from canonical storage (contracts §4).
 *
 * The client never sends history — only the new user message, which is already
 * persisted by the time this runs. Everything here is read back from the
 * Markdown, so what the model sees is exactly what is on disk.
 */

export interface BudgetOptions {
  /** Administrator-configured, prepended ahead of the conversation's own. */
  systemPrompt?: string | undefined;
  /** The model's real context length when known, else `DEFAULT_CONTEXT_TOKENS`. */
  contextTokens: number;
  /** Reserved for the reply; subtracted from the context to get the input budget. */
  maxOutputTokens: number;
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

function costOf(message: ChatMessage): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
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
  { contextTokens, maxOutputTokens, systemPrompt }: BudgetOptions
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
      turns.push({ role: 'user', content: message.body });
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
