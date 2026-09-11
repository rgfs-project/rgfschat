import { randomUUID } from 'node:crypto';
import { deriveTitle, DEFAULT_TITLE, type AssistantMessage } from '@shared/conversation.ts';
import type { GenerationState, TerminalState } from '@shared/generation.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import type { ProviderHub } from '../provider/hub.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import { entryFor, type ChatIndex } from '../storage/index.ts';
import { conversationKey } from '../storage/locks.ts';
import type { GenerationManager } from './manager.ts';
import { assemblePrompt } from './prompt.ts';
import type { CheckpointStore } from './checkpoints.ts';

/**
 * Binds server-owned generation to canonical storage (contracts §4).
 *
 * Generation state is never a second message store: the manager holds only
 * in-flight output, and the Markdown is the record. Exactly one assistant block
 * is written, when the generation reaches a terminal state (INV-07).
 */

/**
 * The Markdown `status` enum and the in-memory generation state deliberately
 * differ: contracts §3.4 spells the success value `complete`, while a
 * generation reaches `completed`. Mapping in one place keeps the file format
 * authoritative without renaming either side.
 */
const STATUS_FOR_STATE: Record<TerminalState, AssistantMessage['status']> = {
  completed: 'complete',
  cancelled: 'cancelled',
  failed: 'failed',
  timed_out: 'timed_out',
};

export interface GenerationServiceOptions {
  store: ConversationStore;
  index: ChatIndex;
  manager: GenerationManager;
  hub: ProviderHub;
  checkpoints?: CheckpointStore;
  logger: Logger;
  defaultContextTokens: number;
  maxOutputTokens: number;
}

export interface StartResult {
  generationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export class GenerationService {
  readonly #store: ConversationStore;
  readonly #index: ChatIndex;
  readonly #manager: GenerationManager;
  readonly #hub: ProviderHub;
  readonly #checkpoints: CheckpointStore | undefined;
  readonly #logger: Logger;
  readonly #defaultContextTokens: number;
  readonly #maxOutputTokens: number;

  /** Conversations with a generation that has not yet reached a terminal state. */
  readonly #active = new Map<string, string>();

  constructor(options: GenerationServiceOptions) {
    this.#store = options.store;
    this.#index = options.index;
    this.#manager = options.manager;
    this.#hub = options.hub;
    this.#checkpoints = options.checkpoints;
    this.#logger = options.logger;
    this.#defaultContextTokens = options.defaultContextTokens;
    this.#maxOutputTokens = options.maxOutputTokens;
  }

  /**
   * Persists the user message, then starts a generation.
   *
   * The whole check-and-append runs under the conversation lock, so two
   * simultaneous sends cannot both pass the in-progress check (INV-13), and the
   * user message is durable before this resolves — and therefore before the
   * route returns 202 (INV-08).
   */
  async start(
    userId: string,
    conversationId: string,
    providerId: string,
    model: string,
    content: string
  ): Promise<StartResult> {
    const key = conversationKey(userId, conversationId);

    // The pair is validated against the server-side catalog before anything is
    // minted or persisted (INV-18). A model valid on another provider is not
    // valid here.
    const { entry, client } = await this.#hub.resolveModel(providerId, model);

    const prepared = await this.#store.locks.run(key, async () => {
      if (this.#active.has(key)) {
        // The user message is deliberately not persisted in this case.
        throw new AppError(
          'GENERATION_IN_PROGRESS',
          'This conversation already has a generation in progress.'
        );
      }

      const current = await this.#store.load(userId, conversationId);

      const userMessageId = randomUUID();
      const next = {
        ...current,
        messages: [
          ...current.messages,
          { type: 'user' as const, id: userMessageId, body: content },
        ],
      };

      // Assemble against the conversation *including* the new message, and do
      // it before writing anything, so an over-budget request fails without
      // leaving a persisted message that was never answered.
      const prompt = assemblePrompt(next, {
        contextTokens:
          client.contextLength(model) ?? entry.contextTokens ?? this.#defaultContextTokens,
        maxOutputTokens: this.#maxOutputTokens,
      });

      const written = await this.#store.writeUnderLock(userId, conversationId, next);
      await this.#index.upsert(userId, entryFor(conversationId, written));

      return { userMessageId, prompt, title: written.title };
    });

    if (prepared.prompt.dropped > 0) {
      this.#logger.info('Dropped oldest messages to fit the context budget', {
        conversationId,
        dropped: prepared.prompt.dropped,
      });
    }

    const { generationId, assistantMessageId } = this.#manager.start(
      userId,
      model,
      prepared.prompt.messages,
      client,
      { conversationId, providerId }
    );
    this.#active.set(key, generationId);

    void this.#persistOnTerminal({
      userId,
      conversationId,
      key,
      generationId,
      assistantMessageId,
      providerId,
      model,
      hadDefaultTitle: prepared.title === DEFAULT_TITLE,
    });

    return { generationId, userMessageId: prepared.userMessageId, assistantMessageId };
  }

  /**
   * Re-runs the last assistant turn.
   *
   * The trailing assistant message is dropped first, so the model is asked the
   * same question rather than being shown its own previous answer and asked to
   * continue. Everything runs under the conversation lock, so it cannot
   * interleave with a send (INV-13).
   */
  async regenerate(
    userId: string,
    conversationId: string,
    providerId: string,
    model: string
  ): Promise<{ generationId: string; assistantMessageId: string }> {
    const key = conversationKey(userId, conversationId);
    const { entry, client } = await this.#hub.resolveModel(providerId, model);

    const prepared = await this.#store.locks.run(key, async () => {
      if (this.#active.has(key)) {
        throw new AppError(
          'GENERATION_IN_PROGRESS',
          'This conversation already has a generation in progress.'
        );
      }

      const current = await this.#store.load(userId, conversationId);

      const trimmed =
        current.messages.at(-1)?.type === 'assistant'
          ? current.messages.slice(0, -1)
          : current.messages;

      if (trimmed.at(-1)?.type !== 'user') {
        throw AppError.validation('There is no user message to regenerate from.');
      }

      const next = { ...current, messages: trimmed };
      const prompt = assemblePrompt(next, {
        contextTokens:
          client.contextLength(model) ?? entry.contextTokens ?? this.#defaultContextTokens,
        maxOutputTokens: this.#maxOutputTokens,
      });

      const written = await this.#store.writeUnderLock(userId, conversationId, next);
      await this.#index.upsert(userId, entryFor(conversationId, written));

      return { prompt, title: written.title };
    });

    const { generationId, assistantMessageId } = this.#manager.start(
      userId,
      model,
      prepared.prompt.messages,
      client,
      { conversationId, providerId }
    );
    this.#active.set(key, generationId);

    void this.#persistOnTerminal({
      userId,
      conversationId,
      key,
      generationId,
      assistantMessageId,
      providerId,
      model,
      // A regenerate never re-titles: the conversation already has its title.
      hadDefaultTitle: false,
    });

    return { generationId, assistantMessageId };
  }

  /** Whether a conversation currently has a non-terminal generation. */
  activeGenerationId(userId: string, conversationId: string): string | null {
    return this.#active.get(conversationKey(userId, conversationId)) ?? null;
  }

  /**
   * Waits for the terminal state, then appends the assistant block exactly once.
   *
   * If the conversation was deleted while the generation ran, the output is
   * discarded and logged rather than resurrecting the file.
   */
  async #persistOnTerminal(context: {
    userId: string;
    conversationId: string;
    key: string;
    generationId: string;
    assistantMessageId: string;
    providerId: string;
    model: string;
    hadDefaultTitle: boolean;
  }): Promise<void> {
    const { userId, conversationId, key, generationId, providerId, model } = context;

    try {
      const final = await this.#manager.whenTerminal(generationId);

      await this.#store.locks.run(key, async () => {
        if (!(await this.#store.exists(userId, conversationId))) {
          this.#logger.info('Discarding generation output for a deleted conversation', {
            conversationId,
            generationId,
          });
          return;
        }

        const current = await this.#store.load(userId, conversationId);

        const assistant: AssistantMessage = {
          type: 'assistant',
          id: context.assistantMessageId,
          status: STATUS_FOR_STATE[final.state],
          provider: providerId,
          model,
          ...(final.reasoning !== '' ? { reasoning: final.reasoning } : {}),
          body: final.content,
        };

        // Auto-title once a reply completes, unless the conversation has been
        // renamed (contracts §3.3). The title comes from the conversation's
        // *first* user message, not the one just sent — if an earlier
        // generation failed, the title still belongs to the question that
        // opened the conversation.
        const firstUserMessage = current.messages.find((message) => message.type === 'user');
        const title =
          context.hadDefaultTitle &&
          final.state === 'completed' &&
          current.title === DEFAULT_TITLE &&
          firstUserMessage !== undefined
            ? deriveTitle(firstUserMessage.body)
            : current.title;

        const written = await this.#store.writeUnderLock(userId, conversationId, {
          ...current,
          title,
          messages: [...current.messages, assistant],
        });
        await this.#index.upsert(userId, entryFor(conversationId, written));

        // The canonical write has landed, so the checkpoint can go. If the
        // process dies before this line, recovery finds the message already
        // present and skips it rather than writing twice.
        await this.#checkpoints?.remove(generationId);
      });
    } catch (err) {
      this.#logger.error('Failed to persist generation output', {
        conversationId,
        generationId,
        error: err,
      });
    } finally {
      // Released only after the write, so the next send cannot start while the
      // assistant block is still being appended.
      if (this.#active.get(key) === generationId) this.#active.delete(key);
    }
  }

  /** Cancels and waits for the write, so callers observe a settled conversation. */
  async cancel(userId: string, conversationId: string, generationId: string): Promise<void> {
    this.#manager.cancel(generationId, userId);
    await this.#manager.whenTerminal(generationId);
    void userId;
    void conversationId;
  }

  /** Resolves once no generation is in flight for the conversation. */
  async settled(userId: string, conversationId: string): Promise<void> {
    const key = conversationKey(userId, conversationId);
    for (let i = 0; i < 500 && this.#active.has(key); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Resolves once nothing is in flight at all.
   *
   * Persistence happens *after* the generation reaches a terminal state, so a
   * caller that tears down storage the moment a stream ends can race the write.
   * This waits on the actual condition rather than sleeping a fixed interval.
   */
  async allSettled(): Promise<void> {
    for (let i = 0; i < 500 && this.#active.size > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

export function isTerminalState(state: GenerationState): state is TerminalState {
  return state !== 'pending' && state !== 'streaming';
}
