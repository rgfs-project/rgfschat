import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { GENERATION_STATES, type GenerationState } from '@shared/generation.ts';
import type { Logger } from '../logger.ts';
import { atomicWriteFile, ensureDir } from '../storage/atomic.ts';
import type { StoragePaths } from '../storage/paths.ts';

/**
 * Generation checkpoints — `_system/generations/<generation-uuid>.json`.
 *
 * A checkpoint is **disposable state**, never conversation history: the
 * canonical Markdown stays authoritative and this file exists only so a restart
 * can tell what was in flight and finish it honestly (contracts §1).
 *
 * Writes happen on every state transition and, while streaming, at most once
 * per `GENERATION_CHECKPOINT_MS`. Writing per token would turn a long reply
 * into thousands of fsyncs for information nobody reads unless we crash.
 */

export interface Checkpoint {
  generationId: string;
  ownerId: string;
  conversationId: string;
  assistantMessageId: string;
  providerId: string;
  model: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
}

const schema = z.strictObject({
  generationId: z.string(),
  ownerId: z.string(),
  conversationId: z.string(),
  assistantMessageId: z.string(),
  providerId: z.string(),
  model: z.string(),
  state: z.enum(GENERATION_STATES),
  content: z.string(),
  reasoning: z.string(),
  lastEventId: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class CheckpointStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;

  constructor(options: { paths: StoragePaths; logger: Logger }) {
    this.#paths = options.paths;
    this.#logger = options.logger;
  }

  #dir(): string {
    return join(this.#paths.systemDir(), 'generations');
  }

  #file(generationId: string): string {
    if (!isCanonicalUuid(generationId)) {
      throw new Error('checkpoint id must be a canonical UUID');
    }
    return join(this.#dir(), `${generationId}.json`);
  }

  async write(checkpoint: Checkpoint): Promise<void> {
    await ensureDir(this.#dir());
    await atomicWriteFile(
      this.#file(checkpoint.generationId),
      `${JSON.stringify(checkpoint, null, 2)}\n`
    );
  }

  async remove(generationId: string): Promise<void> {
    await unlink(this.#file(generationId)).catch(() => undefined);
  }

  async read(generationId: string): Promise<Checkpoint | null> {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(this.#file(generationId), 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Every readable checkpoint on disk.
   *
   * An unreadable one is logged and skipped rather than failing the scan: a
   * single corrupt file must not stop the server booting.
   */
  async list(): Promise<Checkpoint[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir());
    } catch {
      return [];
    }

    const checkpoints: Checkpoint[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      if (!isCanonicalUuid(id)) continue;

      const checkpoint = await this.read(id);
      if (checkpoint === null) {
        this.#logger.warn('Skipping unreadable generation checkpoint', { generationId: id });
        continue;
      }
      checkpoints.push(checkpoint);
    }
    return checkpoints;
  }
}
