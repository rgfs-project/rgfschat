import { randomUUID } from 'node:crypto';
import { deriveTitle, DEFAULT_TITLE, type AssistantMessage } from '@shared/conversation.ts';
import type { GenerationState, SamplerSettings, TerminalState } from '@shared/generation.ts';
import { AppError } from '../errors/AppError.ts';
import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentKind } from '@shared/attachment.ts';
import { resolveAttachments } from '../attachments/resolve.ts';
import type { AttachmentStore } from '../attachments/store.ts';
import type { ModelDto } from '@shared/generation.ts';
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
  /** Phase 11. Absent in tests that do not exercise attachments. */
  attachments?: AttachmentStore;
  /** Characters of a text attachment inlined into a prompt. */
  maxInlineChars?: number;
  store: ConversationStore;
  index: ChatIndex;
  manager: GenerationManager;
  hub: ProviderHub;
  checkpoints?: CheckpointStore;
  logger: Logger;
  defaultContextTokens: number;
  maxOutputTokens: number;
  /**
   * Per-model sampler and system prompt, applied here rather than accepted
   * from the browser: these are an administrator's settings for everyone, and
   * a client that could send its own would be setting policy for itself.
   */
  settings?: { samplerFor: (providerId: string, modelId: string) => SamplerSettings };
  /**
   * What this reader has asked to be remembered, prepended to the system
   * prompt of their own generations.
   *
   * Per user, so it is read here rather than passed in by the route: a caller
   * that supplied its own memories would be writing another reader's context.
   */
  memories?: { prompt: (userId: string) => Promise<string | null> };
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
  readonly #attachments: GenerationServiceOptions['attachments'];
  readonly #maxInlineChars: number;
  readonly #settings: GenerationServiceOptions['settings'];
  readonly #memories: GenerationServiceOptions['memories'];

  /** Conversations with a generation that has not yet reached a terminal state. */
  readonly #active = new Map<string, string>();

  constructor(options: GenerationServiceOptions) {
    this.#store = options.store;
    this.#index = options.index;
    this.#manager = options.manager;
    this.#hub = options.hub;
    this.#attachments = options.attachments;
    this.#maxInlineChars = options.maxInlineChars ?? 100_000;
    this.#checkpoints = options.checkpoints;
    this.#logger = options.logger;
    this.#defaultContextTokens = options.defaultContextTokens;
    this.#maxOutputTokens = options.maxOutputTokens;
    this.#settings = options.settings;
    this.#memories = options.memories;
  }

  /**
   * The system prompt for one generation: the administrator's for this model,
   * with the reader's memories ahead of it.
   *
   * Memories lead because the model's instruction is about *how* to answer and
   * the memories are about *who it is answering* — and because an
   * administrator's instruction reads better as the last word.
   */
  async #systemPromptFor(userId: string, sampler: SamplerSettings): Promise<string | undefined> {
    const remembered = (await this.#memories?.prompt(userId)) ?? null;
    const configured = sampler.systemPrompt;

    if (remembered === null) return configured;
    return configured === undefined || configured.trim() === ''
      ? remembered
      : `${remembered}\n\n${configured}`;
  }

  /** The configured sampling for a model, or nothing. */
  #samplerFor(providerId: string, model: string): SamplerSettings {
    return this.#settings?.samplerFor(providerId, model) ?? {};
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
    content: string,
    attachmentIds: readonly string[] = []
  ): Promise<StartResult> {
    const key = conversationKey(userId, conversationId);

    // The pair is validated against the server-side catalog before anything is
    // minted or persisted (INV-18). A model valid on another provider is not
    // valid here.
    const { entry, client, model: modelDto } = await this.#hub.resolveModel(providerId, model);

    /*
     * Everything that could refuse this request happens before the lock and
     * before anything is written: the attachments must exist, belong to the
     * caller, be unattached, and be something this model can actually read.
     *
     * The capability check in particular has to be here rather than at send
     * time. A model without a projector answers an image with a 500
     * (docs/provider-notes.md §9), and by then the user's message would
     * already be on disk — so the conversation would carry a question that was
     * never answerable.
     */
    const attached = await this.#prepareAttachments(userId, attachmentIds, modelDto);
    const sampler = this.#samplerFor(providerId, model);
    // Read before the lock: it touches the filesystem, and the lock is held
    // across the whole check-and-append.
    const systemPrompt = await this.#systemPromptFor(userId, sampler);

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
          {
            type: 'user' as const,
            id: userMessageId,
            createdAt: this.#store.timestamp(),
            body: content,
            ...(attached.length === 0 ? {} : { attachments: attached.map((a) => a.id) }),
          },
        ],
      };

      // Assemble against the conversation *including* the new message, and do
      // it before writing anything, so an over-budget request fails without
      // leaving a persisted message that was never answered.
      const modalities = modelDto.inputModalities;
      const resolved =
        this.#attachments === undefined
          ? new Map()
          : await resolveAttachments(this.#attachments, userId, next, {
              maxInlineChars: this.#maxInlineChars,
              modalities,
            });

      const prompt = assemblePrompt(next, {
        contextTokens:
          client.contextLength(model) ?? entry.contextTokens ?? this.#defaultContextTokens,
        maxOutputTokens: this.#maxOutputTokens,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        attachments: resolved,
        modalities,
      });

      const written = await this.#store.writeUnderLock(userId, conversationId, next);
      await this.#index.upsert(userId, entryFor(conversationId, written));

      /*
       * Linked after the Markdown is durable, and inside the lock.
       *
       * This order is the one that can be recovered from. A crash between the
       * two leaves attachments pending that a message already references, and
       * startup reconciliation links them by reading the Markdown back. The
       * other order would leave an attachment claiming to belong to a message
       * that was never written, which nothing can detect.
       */
      if (this.#attachments !== undefined && attached.length > 0) {
        await this.#attachments.link(
          userId,
          attached.map((a) => a.id),
          conversationId,
          userMessageId
        );
      }

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
      { conversationId, providerId, sampler }
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
  /**
   * Checks the attachments a message wants to carry, before anything is written.
   *
   * Each must be the caller's own and still pending — linking one that already
   * belongs to a message would give two messages a claim on the same bytes, and
   * deleting either conversation would then break the other.
   */
  async #prepareAttachments(
    userId: string,
    attachmentIds: readonly string[],
    model: ModelDto
  ): Promise<{ id: string; kind: AttachmentKind }[]> {
    if (attachmentIds.length === 0) return [];

    if (this.#attachments === undefined) {
      throw AppError.validation('Attachments are not enabled on this server.');
    }
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw AppError.validation(
        `A message may carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw AppError.validation('The same attachment was listed twice.');
    }

    const prepared: { id: string; kind: AttachmentKind }[] = [];
    for (const id of attachmentIds) {
      // Cross-user ids are `NOT_FOUND` from the store, which is what the
      // caller sees: ownership is never revealed (contracts §5).
      const meta = await this.#attachments.read(userId, id);
      if (meta.messageId !== null) {
        throw AppError.validation('That attachment is already part of a message.');
      }
      prepared.push({ id: meta.id, kind: meta.kind });
    }

    /*
     * Every attachment must be something this model can take in. Checked per
     * kind rather than as one "multimodal" flag: a model that reads images and
     * not audio is the common case, not an edge one — on the reference server
     * every Gemma and Qwen model accepts images and only some Gemma variants
     * accept audio.
     */
    for (const kind of ['image', 'audio'] as const) {
      if (!prepared.some((attachment) => attachment.kind === kind)) continue;
      if (model.inputModalities.includes(kind)) continue;

      throw new AppError(
        'MODEL_CAPABILITY_UNSUPPORTED',
        kind === 'image'
          ? 'This model cannot read images. Choose a model that can, or remove the image.'
          : 'This model cannot listen to audio. Choose a model that can, or remove the audio.'
      );
    }

    return prepared;
  }

  async regenerate(
    userId: string,
    conversationId: string,
    providerId: string,
    model: string
  ): Promise<{ generationId: string; assistantMessageId: string }> {
    const key = conversationKey(userId, conversationId);
    const { entry, client } = await this.#hub.resolveModel(providerId, model);
    const sampler = this.#samplerFor(providerId, model);
    // Read before the lock: it touches the filesystem, and the lock is held
    // across the whole check-and-append.
    const systemPrompt = await this.#systemPromptFor(userId, sampler);

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
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
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
      { conversationId, providerId, sampler }
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

  /**
   * The conversation's generation, if one is genuinely still running.
   *
   * `#active` is cleared only once the canonical write has landed, which leaves
   * a window where the run has reached a terminal state but the entry is still
   * present. Reporting it during that window makes a reloading client subscribe
   * to a finished generation and render a second, permanently pending reply —
   * so the manager's state is the authority here, not the map.
   */
  activeGenerationId(userId: string, conversationId: string): string | null {
    const generationId = this.#active.get(conversationKey(userId, conversationId));
    if (generationId === undefined) return null;

    const snapshot = this.#manager.get(generationId, userId);
    if (snapshot === null || isTerminalState(snapshot.state)) return null;

    return generationId;
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
          createdAt: this.#store.timestamp(),
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
