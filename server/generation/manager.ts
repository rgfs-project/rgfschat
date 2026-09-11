import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  ChatMessage,
  GenerationEvent,
  GenerationSnapshotDto,
  GenerationState,
  TerminalState,
} from '@shared/generation.ts';
import { isTerminal } from '@shared/generation.ts';
import { AppError, isAppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import type { Provider } from '../provider/types.ts';

export interface GenerationManagerOptions {
  provider: Provider;
  logger: Logger;
  maxOutputTokens: number;
  /** How long a terminal generation stays observable before eviction. */
  retentionMs?: number;
  /** Hard cap on retained generations, oldest terminal ones evicted first. */
  maxRetained?: number;
  now?: () => Date;
}

interface GenerationRecord {
  id: string;
  assistantMessageId: string;
  model: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  errorCode: string | undefined;
  createdAt: Date;
  updatedAt: Date;
  lastEventId: number;
  abort: AbortController;
  emitter: EventEmitter;
  terminalAt: Date | undefined;
}

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETAINED = 100;

/**
 * Owns every in-flight generation.
 *
 * Generation is server-owned: it starts when `POST /api/generations` returns and
 * continues regardless of whether anyone is watching. Closing an SSE connection
 * never cancels it (INV-06) — only an explicit cancel, a provider failure, a
 * timeout, or completion moves it to a terminal state, and exactly one of those
 * ever wins (INV-05).
 *
 * Phase 2 keeps all of this in memory; Phase 6 makes it durable across restarts.
 */
export class GenerationManager {
  readonly #generations = new Map<string, GenerationRecord>();
  readonly #provider: Provider;
  readonly #logger: Logger;
  readonly #maxOutputTokens: number;
  readonly #retentionMs: number;
  readonly #maxRetained: number;
  readonly #now: () => Date;

  constructor({
    provider,
    logger,
    maxOutputTokens,
    retentionMs = DEFAULT_RETENTION_MS,
    maxRetained = DEFAULT_MAX_RETAINED,
    now = () => new Date(),
  }: GenerationManagerOptions) {
    this.#provider = provider;
    this.#logger = logger;
    this.#maxOutputTokens = maxOutputTokens;
    this.#retentionMs = retentionMs;
    this.#maxRetained = maxRetained;
    this.#now = now;
  }

  /**
   * Creates a generation and starts it in the background.
   *
   * Returns as soon as the ids are minted so the route can reply `202`; the
   * provider call is deliberately not awaited.
   */
  start(
    model: string,
    messages: ChatMessage[]
  ): { generationId: string; assistantMessageId: string } {
    const createdAt = this.#now();
    const record: GenerationRecord = {
      id: randomUUID(),
      assistantMessageId: randomUUID(),
      model,
      state: 'pending',
      content: '',
      reasoning: '',
      errorCode: undefined,
      createdAt,
      updatedAt: createdAt,
      lastEventId: 0,
      abort: new AbortController(),
      emitter: new EventEmitter(),
      terminalAt: undefined,
    };

    // Many observers may attach; none of them should trip the warning.
    record.emitter.setMaxListeners(0);
    this.#generations.set(record.id, record);
    this.#evict();

    void this.#run(record, messages);

    return { generationId: record.id, assistantMessageId: record.assistantMessageId };
  }

  async #run(record: GenerationRecord, messages: ChatMessage[]): Promise<void> {
    try {
      const stream = this.#provider.streamChat({
        model: record.model,
        messages,
        maxOutputTokens: this.#maxOutputTokens,
        signal: record.abort.signal,
      });

      for await (const chunk of stream) {
        // A terminal state may have been reached by cancel while we awaited the
        // next chunk. Late chunks are dropped rather than resurrecting it.
        if (isTerminal(record.state)) return;

        if (record.state === 'pending') this.#setState(record, 'streaming');

        if (chunk.type === 'content') {
          record.content += chunk.text;
          this.#emit(record, { type: 'content', delta: chunk.text });
        } else if (chunk.type === 'reasoning') {
          record.reasoning += chunk.text;
          this.#emit(record, { type: 'reasoning', delta: chunk.text });
        }
        record.updatedAt = this.#now();
      }

      this.#finish(record, 'completed');
    } catch (err) {
      if (isTerminal(record.state)) return;

      if (record.abort.signal.aborted) {
        // Cancel() already moved it to `cancelled`; this is just the unwind.
        this.#finish(record, 'cancelled');
        return;
      }

      if (isAppError(err) && err.code === 'PROVIDER_TIMEOUT') {
        this.#finish(record, 'timed_out', err.code);
        return;
      }

      const code = isAppError(err) ? err.code : 'INTERNAL';
      this.#logger.error('Generation failed', {
        generationId: record.id,
        model: record.model,
        code,
        error: err instanceof Error ? err : { message: String(err) },
      });
      this.#finish(record, 'failed', code);
    }
  }

  /**
   * The single guarded transition into a terminal state (INV-05).
   * Every path — completion, cancel, failure, timeout — goes through here, and
   * the first one to arrive wins.
   */
  #finish(record: GenerationRecord, state: TerminalState, errorCode?: string): void {
    if (isTerminal(record.state)) return;

    record.state = state;
    record.errorCode = errorCode;
    record.updatedAt = this.#now();
    record.terminalAt = record.updatedAt;

    this.#emit(record, { type: 'state', state });
    this.#emit(record, {
      type: 'done',
      state,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
  }

  #setState(record: GenerationRecord, state: GenerationState): void {
    if (isTerminal(record.state)) return;
    record.state = state;
    record.updatedAt = this.#now();
    this.#emit(record, { type: 'state', state });
  }

  #emit(record: GenerationRecord, event: GenerationEvent): void {
    record.lastEventId += 1;
    record.emitter.emit('event', { id: record.lastEventId, event });
  }

  get(id: string): GenerationSnapshotDto | null {
    const record = this.#generations.get(id);
    return record === undefined ? null : toSnapshot(record);
  }

  /** Throws `GENERATION_NOT_FOUND` rather than returning null, for route use. */
  require(id: string): GenerationSnapshotDto {
    const snapshot = this.get(id);
    if (snapshot === null) {
      throw new AppError('GENERATION_NOT_FOUND', 'Generation not found.');
    }
    return snapshot;
  }

  cancel(id: string): GenerationSnapshotDto {
    const record = this.#generations.get(id);
    if (record === undefined) {
      throw new AppError('GENERATION_NOT_FOUND', 'Generation not found.');
    }

    if (!isTerminal(record.state)) {
      // Transition first, then abort: if the abort unwinds synchronously, the
      // guard in #finish has already claimed the terminal state.
      this.#finish(record, 'cancelled');
      record.abort.abort();
    }

    return toSnapshot(record);
  }

  /**
   * Subscribes to live events. Returns an unsubscribe function.
   * Unsubscribing never affects the generation itself (INV-06).
   */
  subscribe(
    id: string,
    listener: (envelope: { id: number; event: GenerationEvent }) => void
  ): () => void {
    const record = this.#generations.get(id);
    if (record === undefined) {
      throw new AppError('GENERATION_NOT_FOUND', 'Generation not found.');
    }

    record.emitter.on('event', listener);
    return () => record.emitter.off('event', listener);
  }

  /** Evicts terminal generations past the retention window, then enforces the cap. */
  #evict(): void {
    const cutoff = this.#now().getTime() - this.#retentionMs;

    for (const [id, record] of this.#generations) {
      if (record.terminalAt !== undefined && record.terminalAt.getTime() < cutoff) {
        this.#generations.delete(id);
      }
    }

    if (this.#generations.size <= this.#maxRetained) return;

    const terminal = [...this.#generations.entries()]
      .filter(([, r]) => r.terminalAt !== undefined)
      .sort((a, b) => (a[1].terminalAt?.getTime() ?? 0) - (b[1].terminalAt?.getTime() ?? 0));

    for (const [id] of terminal) {
      if (this.#generations.size <= this.#maxRetained) break;
      this.#generations.delete(id);
    }
  }

  /** Cancels everything in flight. Used on shutdown and between tests. */
  shutdown(): void {
    for (const record of this.#generations.values()) {
      if (!isTerminal(record.state)) {
        this.#finish(record, 'cancelled');
        record.abort.abort();
      }
    }
    this.#generations.clear();
  }

  get size(): number {
    return this.#generations.size;
  }
}

function toSnapshot(record: GenerationRecord): GenerationSnapshotDto {
  return {
    generationId: record.id,
    assistantMessageId: record.assistantMessageId,
    model: record.model,
    state: record.state,
    content: record.content,
    reasoning: record.reasoning,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    lastEventId: record.lastEventId,
  };
}
