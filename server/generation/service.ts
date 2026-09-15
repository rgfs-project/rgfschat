import { randomUUID } from 'node:crypto';
import {
  deriveTitle,
  DEFAULT_TITLE,
  hasSendableContent,
  type AssistantMessage,
} from '@shared/conversation.ts';
import type {
  ChatMessage,
  GenerationState,
  SamplerSettings,
  TerminalState,
  ToolCall,
} from '@shared/generation.ts';
import { AppError } from '../errors/AppError.ts';
import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentKind } from '@shared/attachment.ts';
import { resolveAttachments } from '../attachments/resolve.ts';
import type { AttachmentStore } from '../attachments/store.ts';
import type { ModelDto } from '@shared/generation.ts';
import type { Logger } from '../logger.ts';
import type { ProviderHub } from '../provider/hub.ts';
import type { ConversationStore } from '../storage/conversations.ts';
import type { ProposalStore } from '../storage/proposals.ts';
import { MEMORY_TOOLS, parseMemoryCall } from '../memory/tools.ts';
import { fileBlocksIn, FILE_BLOCK_INSTRUCTION } from '@shared/artifactBlocks.ts';
import type { ArtifactStore } from '../storage/artifacts.ts';
import { applyPromptVariables } from '@shared/promptVariables.ts';
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
/**
 * What a completed turn says when the model said nothing at all.
 *
 * A reply that asked to save a memory and then stopped is stored as a complete
 * assistant message with an empty body — which reads, in the transcript, as a
 * turn that ended mid-thought: the reasoning is there and then nothing. The
 * continuation turn is the real fix and usually produces a sentence; this is
 * what is written when even that comes back empty, so a complete turn is never
 * a blank one. Reasoning is deliberately not promoted into its place: it is
 * the model's working, not its answer, and presenting it as the answer would
 * show the reader something the model never addressed to them.
 */
const PROPOSAL_FALLBACK_BODY = 'I’d like to remember this. Review the proposal below.';

/** The same, for a completed turn that produced neither content nor a call. */
const EMPTY_FALLBACK_BODY = 'I don’t have anything to add here.';

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
  memories?: {
    prompt: (userId: string, options?: { tools?: boolean }) => Promise<string | null>;
    /**
     * Optional, and used only to stamp a proposal with the note it was made
     * about: a caller that supplies a bare `prompt` still gets working
     * proposals, they just carry no baseline for the staleness check.
     */
    read?: (userId: string, name: string) => Promise<{ updatedAt: string } | null>;
  };
  /**
   * Where memory changes the model asks for are parked until the reader answers.
   *
   * Its presence is what turns the memory tools on: without somewhere to put a
   * proposal there is nothing useful to do with a call, so the model is not
   * offered one. That also keeps every existing caller — the tests among them —
   * sending exactly the request it sent before.
   */
  proposals?: ProposalStore;
  /**
   * Where files a completed reply presented are kept.
   *
   * Absent turns the capture off, exactly as `proposals` turns memory tools
   * off: a server that has not opted in behaves as it did before any of this
   * existed, and every test that does not care keeps its old assertions.
   */
  artifacts?: ArtifactStore;
  /**
   * Resolves the name a placeholder in a system prompt should be filled with.
   *
   * A function rather than the `UserStore` itself, so this stays the narrowest
   * thing that works: generation has no business being able to rename or delete
   * an account because it needed to read one field.
   */
  users?: { usernameFor: (userId: string) => Promise<string | null> };
  /** Injectable so a test can pin the instant stamped on a message. */
  now?: () => Date;
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
  readonly #proposals: ProposalStore | undefined;
  readonly #artifacts: ArtifactStore | undefined;
  readonly #users: GenerationServiceOptions['users'];
  readonly #now: () => Date;

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
    this.#proposals = options.proposals;
    this.#artifacts = options.artifacts;
    this.#users = options.users;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /**
   * The system prompt for one generation: the administrator's for this model,
   * with the reader's memories ahead of it.
   *
   * Memories lead because the model's instruction is about *how* to answer and
   * the memories are about *who it is answering* — and because an
   * administrator's instruction reads better as the last word.
   */
  async #systemPromptFor(
    userId: string,
    sampler: SamplerSettings,
    timeZone: string | undefined
  ): Promise<string | undefined> {
    const remembered =
      (await this.#memories?.prompt(userId, { tools: this.#toolsEnabled })) ?? null;
    const configured = await this.#fillVariables(userId, sampler.systemPrompt, timeZone);
    /*
     * The one thing a model cannot infer: that naming a fenced block saves it.
     *
     * Only when there is somewhere to save it to, so a server without an
     * artifact store does not advertise a format it would then ignore.
     */
    const files = this.#artifacts === undefined ? null : FILE_BLOCK_INSTRUCTION;

    const sections = [remembered, files, configured].filter(
      (section): section is string =>
        section !== null && section !== undefined && section.trim() !== ''
    );
    return sections.length === 0 ? undefined : sections.join('\n\n');
  }

  /**
   * Fills `{{CURRENT_DATETIME}}` and friends in the administrator's prompt.
   *
   * Only that prompt. Memories are the reader's own words and are left exactly
   * as written — a note that happens to contain double braces is a note, not a
   * template, and rewriting it would change what the reader asked to be
   * remembered.
   *
   * Done per generation, because the whole point of a clock is that it moves.
   */
  async #fillVariables(
    userId: string,
    template: string | undefined,
    timeZone: string | undefined
  ): Promise<string | undefined> {
    if (template === undefined || !template.includes('{{')) return template;

    const userName = (await this.#users?.usernameFor(userId)) ?? '';

    return applyPromptVariables(template, {
      userName,
      now: this.#now(),
      // Absent means the client did not send one — an older build, or a
      // non-browser caller. The server's own zone is a worse guess than saying
      // so plainly, which `resolvePromptVariables` does by falling back to UTC.
      timeZone: timeZone ?? '',
    });
  }

  /** Whether this server can do anything with a call the model makes. */
  get #toolsEnabled(): boolean {
    return this.#proposals !== undefined && this.#memories !== undefined;
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
    attachmentIds: readonly string[] = [],
    /** The reader's IANA zone, for the clock placeholders. */
    timeZone?: string
  ): Promise<StartResult> {
    const key = conversationKey(userId, conversationId);

    /*
     * Repeated here, inside the service boundary.
     *
     * The route's schema already refuses this, and so does the composer — but
     * this method is the thing that writes a message, and a turn with neither
     * text nor an attachment is not a message. Checked before the model is
     * resolved so an empty send costs nothing.
     */
    if (!hasSendableContent(content, attachmentIds)) {
      throw AppError.validation('A message must have text or at least one attachment.');
    }

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
    const systemPrompt = await this.#systemPromptFor(userId, sampler, timeZone);

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
            body: content,
            ...(attached.length === 0 ? {} : { attachments: attached.map((a) => a.id) }),
            // Stamped when the question is persisted rather than when the
            // request arrived: the file is the record, and this is the instant
            // the record gained it.
            time: this.#now().toISOString(),
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

    const run = this.#launch(
      userId,
      conversationId,
      providerId,
      model,
      sampler,
      client,
      prepared.prompt.messages
    );
    const { generationId, assistantMessageId } = run;
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
    model: string,
    timeZone?: string
  ): Promise<{ generationId: string; assistantMessageId: string }> {
    const key = conversationKey(userId, conversationId);
    const { entry, client, model: modelDto } = await this.#hub.resolveModel(providerId, model);
    const sampler = this.#samplerFor(providerId, model);
    // Read before the lock: it touches the filesystem, and the lock is held
    // across the whole check-and-append.
    const systemPrompt = await this.#systemPromptFor(userId, sampler, timeZone);

    const prepared = await this.#store.locks.run(key, async () => {
      if (this.#active.has(key)) {
        throw new AppError(
          'GENERATION_IN_PROGRESS',
          'This conversation already has a generation in progress.'
        );
      }

      const current = await this.#store.load(userId, conversationId);

      const last = current.messages.at(-1);
      const replaced = last?.type === 'assistant' ? last : null;
      const trimmed = replaced !== null ? current.messages.slice(0, -1) : current.messages;

      if (trimmed.at(-1)?.type !== 'user') {
        throw AppError.validation('There is no user message to regenerate from.');
      }

      const next = { ...current, messages: trimmed };

      /*
       * Resolved here as well as on the send path, and for the same reason.
       *
       * Without this the map is empty, every attachment in the history is
       * skipped as unresolvable, and the question goes back to the model
       * stripped of the picture it was asking about — so regenerating "what is
       * in this screenshot" asked about nothing at all, and the budget was
       * computed for a prompt that was not the one being sent.
       */
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
       * The replaced turn's proposals go with it, under the same lock as the
       * write that removed it.
       *
       * A card offering to save something out of a reply that is no longer in
       * the conversation is a question with no context — and accepting it
       * would write a memory on the strength of text the reader can no longer
       * read. Doing it here rather than after the lock is what makes it
       * atomic with the removal: there is no moment at which the message is
       * gone and its proposals are still on offer.
       */
      if (replaced !== null) {
        await this.#proposals?.removeForMessage(userId, conversationId, replaced.id);
      }

      return { prompt, title: written.title };
    });

    const run = this.#launch(
      userId,
      conversationId,
      providerId,
      model,
      sampler,
      client,
      prepared.prompt.messages
    );
    const { generationId, assistantMessageId } = run;
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
          // The instant the reply was finished and filed, not the one it was
          // asked for — a long generation is not backdated to its question.
          time: this.#now().toISOString(),
          /*
           * Why it stopped, when it stopped badly.
           *
           * The status already says a reply did not complete; this says what
           * went wrong, so a transcript read tomorrow answers the question the
           * server log answered today. A run that reached a terminal state
           * without a classification simply carries none.
           */
          ...(final.state !== 'completed' && final.errorCode !== undefined
            ? { error: final.errorCode }
            : {}),
          /*
           * Never an empty body on a completed turn.
           *
           * Only for `completed`: a cancelled or failed run legitimately has
           * nothing to show, and its status already says why. A completed one
           * with an empty body is the bug — it renders as a turn that stops
           * after its reasoning — so an application-owned sentence takes its
           * place, saying which of the two things happened.
           */
          body:
            final.state === 'completed' && final.content.trim() === ''
              ? final.toolCalls.length > 0
                ? PROPOSAL_FALLBACK_BODY
                : EMPTY_FALLBACK_BODY
              : final.content,
        };

        // Auto-title once a reply completes, unless the conversation has been
        // renamed (contracts §3.3). The title comes from the conversation's
        // *first* user message, not the one just sent — if an earlier
        // generation failed, the title still belongs to the question that
        // opened the conversation.
        /*
         * Titled from what the reader actually wrote.
         *
         * A message can now be an attachment and nothing else, and its body is
         * genuinely empty — there is no placeholder text to fall back on and
         * inventing one would put words in the reader's mouth. `deriveTitle`
         * answers `New conversation` for an empty string, which is the honest
         * outcome: the conversation keeps its default name until a turn with
         * words in it arrives.
         */
        const firstWritten = current.messages.find(
          (message) => message.type === 'user' && message.body.trim() !== ''
        );
        const title =
          context.hadDefaultTitle &&
          final.state === 'completed' &&
          current.title === DEFAULT_TITLE &&
          firstWritten !== undefined
            ? deriveTitle(firstWritten.body)
            : current.title;

        const written = await this.#store.writeUnderLock(userId, conversationId, {
          ...current,
          title,
          messages: [...current.messages, assistant],
        });
        await this.#index.upsert(userId, entryFor(conversationId, written));

        /*
         * Filed after the reply is durable, and only for a run that finished.
         *
         * A cancelled or failed generation can still have dictated a call
         * before it stopped, and proposing a memory change out of a reply the
         * reader never saw finish would be asking them to approve something
         * with no context for it.
         */
        /*
         * Filed after the reply is durable, and only for a run that finished.
         *
         * Normally a no-op: the continuation filed these as the run ended, so
         * the model could be told what happened to its call. This is the
         * backstop for the paths that take no continuation — a recovered run,
         * or a server with the tools on and nothing to answer them — and it is
         * safe to repeat because `add` recognises a call it has already filed
         * by its `sourceId`.
         */
        if (final.state === 'completed' && final.toolCalls.length > 0) {
          await this.#recordProposals(
            userId,
            conversationId,
            context.assistantMessageId,
            generationId,
            final.toolCalls
          );
        }

        /*
         * The files the reply presented, kept — after the same durable write,
         * and under the same condition.
         *
         * `completed` only: a cancelled or failed run can have got halfway
         * through a file, and half a document saved under the name of a whole
         * one is worse than no document. The body is the one that was just
         * written, so nothing here can see a streaming fragment, a reasoning
         * block, or anything a reader wrote.
         */
        if (final.state === 'completed') {
          await this.#captureArtifacts(
            userId,
            conversationId,
            context.assistantMessageId,
            written.messages.at(-1)?.body ?? final.content
          );
        }

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
      /*
       * Only now is the reader told the reply finished.
       *
       * `done` is what makes the client refetch the conversation and its
       * proposals, so releasing it here — after the message, the proposals and
       * the artifacts are on disk, and in a `finally` so a failed write still
       * releases it — is what stops that refetch racing this write. Before
       * this, the refetch could return a transcript with the new reply in it
       * and a proposal list without the card that came with it.
       */
      this.#manager.markPersisted(generationId);
      // Released only after the write, so the next send cannot start while the
      // assistant block is still being appended.
      if (this.#active.get(key) === generationId) this.#active.delete(key);
    }
  }

  /**
   * Starts one run, with the tool protocol wired to this conversation.
   *
   * Shared by sending and regenerating so the two cannot drift: a run that is
   * offered the memory tools must also be able to answer them, and must be
   * persisted before the reader is told it finished. A regenerate that had one
   * and not the other would be the same bug in half the places.
   */
  #launch(
    userId: string,
    conversationId: string,
    providerId: string,
    model: string,
    sampler: SamplerSettings,
    client: Parameters<GenerationManager['start']>[3],
    messages: Parameters<GenerationManager['start']>[2]
  ): { generationId: string; assistantMessageId: string } {
    /*
     * Filled in immediately below, and read only from the continuation — which
     * cannot run until the first stream has ended, several ticks after this
     * function has returned. The alternative is for the manager to mint the
     * ids and hand them back, which is a larger change to a smaller problem.
     */
    const ids = { generationId: '', assistantMessageId: '' };

    const started = this.#manager.start(userId, model, messages, client, {
      conversationId,
      providerId,
      sampler,
      ...(this.#toolsEnabled
        ? {
            tools: MEMORY_TOOLS,
            continuation: (calls) =>
              this.#answerToolCalls(
                userId,
                conversationId,
                ids.generationId,
                ids.assistantMessageId,
                calls
              ),
          }
        : {}),
      // `done` waits for the persistence below, so a client refetching on it
      // cannot land between the reply and the proposals it came with.
      awaitsPersistence: true,
    });

    ids.generationId = started.generationId;
    ids.assistantMessageId = started.assistantMessageId;
    return started;
  }

  /**
   * Files the proposals a run asked for and tells the model what happened.
   *
   * This is the half of the tool protocol that was missing, and the reason a
   * reply could end with reasoning and nothing else: a model that calls a tool
   * and is never answered has not finished its turn, so it produces no content
   * and the transcript appears to stop mid-thought. Answering it lets it say,
   * in its own words, what it has offered to do.
   *
   * Returns `null` when there is nothing to answer — no store, or not one
   * usable call — in which case no continuation turn is taken at all.
   */
  async #answerToolCalls(
    userId: string,
    conversationId: string,
    generationId: string,
    assistantMessageId: string,
    calls: readonly ToolCall[]
  ): Promise<ChatMessage[] | null> {
    if (this.#proposals === undefined) return null;

    const results: ChatMessage[] = [];
    const entries: Parameters<ProposalStore['add']>[2][number][] = [];

    for (const call of calls) {
      const parsed = parseMemoryCall(call);
      if (!parsed.ok) {
        this.#logger.warn('Discarding a malformed tool call', {
          conversationId,
          tool: call.name,
          reason: parsed.reason,
        });
        // The model is told, rather than left waiting: a call it got wrong is
        // something it can explain to the reader, and silence is not.
        results.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Rejected: ${parsed.reason}. Nothing was saved.`,
        });
        continue;
      }

      const base =
        parsed.value.operation === 'create' || this.#memories?.read === undefined
          ? null
          : await this.#memories.read(userId, parsed.value.name);

      entries.push({
        assistantMessageId,
        operation: parsed.value.operation,
        name: parsed.value.name,
        ...(parsed.value.content === undefined ? {} : { content: parsed.value.content }),
        ...(base === null ? {} : { baseUpdatedAt: base.updatedAt }),
        // The identity a duplicate is recognised by, so a retried or
        // re-processed run cannot ask the reader the same question twice.
        sourceId: `${generationId}:${call.id}`,
      });

      results.push({
        role: 'tool',
        toolCallId: call.id,
        content:
          `Proposed to the user for approval: ${parsed.value.operation} "${parsed.value.name}". ` +
          'Nothing has been saved yet — they must accept it. Tell them briefly what you have ' +
          'offered to remember, and do not claim it is done.',
      });
    }

    if (entries.length > 0) {
      await this.#proposals.add(userId, conversationId, entries, this.#now);
    }

    return results.length === 0 ? null : results;
  }

  /**
   * Turns the calls a finished run made into proposals for the reader.
   *
   * Validation happens here rather than in the manager because this is the
   * layer that chose the tools, and it is deliberately forgiving: a call the
   * model got wrong costs that call and is logged, never the reply it arrived
   * with. Nothing in a memory is written — accepting is the reader's to do.
   */
  async #recordProposals(
    userId: string,
    conversationId: string,
    assistantMessageId: string,
    generationId: string,
    calls: readonly ToolCall[]
  ): Promise<void> {
    if (this.#proposals === undefined) return;

    const entries = [];
    for (const call of calls) {
      const parsed = parseMemoryCall(call);
      if (!parsed.ok) {
        this.#logger.warn('Discarding a malformed tool call', {
          conversationId,
          tool: call.name,
          reason: parsed.reason,
        });
        continue;
      }

      /*
       * The version of the note this proposal is about, recorded now.
       *
       * A proposal can sit unanswered for days, and in between the reader may
       * edit or replace the note themselves. Without this baseline, accepting
       * the old card would quietly overwrite — or delete — work the reader did
       * after the model asked. Only meaningful for an update or a deletion: a
       * `create` has no existing note to be stale against, and its create-only
       * write is what protects it.
       */
      const base =
        parsed.value.operation === 'create' || this.#memories?.read === undefined
          ? null
          : await this.#memories.read(userId, parsed.value.name);

      entries.push({
        assistantMessageId,
        operation: parsed.value.operation,
        name: parsed.value.name,
        ...(parsed.value.content === undefined ? {} : { content: parsed.value.content }),
        ...(base === null ? {} : { baseUpdatedAt: base.updatedAt }),
        // The same identity the continuation files under, so whichever path
        // gets there first, the other one recognises its work and adds nothing.
        sourceId: `${generationId}:${call.id}`,
      });
    }

    await this.#proposals.add(userId, conversationId, entries, this.#now);
  }

  /**
   * Saves each file a completed reply presented, once.
   *
   * Forgiving in the same way `#recordProposals` is: a file the store refuses —
   * too large, or empty once the fence is stripped — costs that file and is
   * logged. The reply is already durable, and failing the persistence of a
   * conversation over an artifact would trade the thing the reader asked for
   * against a copy of part of it.
   */
  async #captureArtifacts(
    userId: string,
    conversationId: string,
    assistantMessageId: string,
    body: string
  ): Promise<void> {
    const artifacts = this.#artifacts;
    if (artifacts === undefined) return;

    for (const block of fileBlocksIn(body)) {
      try {
        // Asked per file, immediately before writing it: a reconnect, a reload
        // or a second completion event lands here with the artifact already on
        // disk, and stops.
        if (
          await artifacts.presentedAlready(userId, conversationId, assistantMessageId, block.name)
        ) {
          continue;
        }

        await artifacts.create(userId, {
          name: block.name,
          mediaType: block.mediaType,
          content: block.content,
          conversationId,
          messageId: assistantMessageId,
        });
      } catch (err) {
        this.#logger.warn('Discarding a presented file', {
          conversationId,
          name: block.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
