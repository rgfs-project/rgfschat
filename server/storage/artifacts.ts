import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  displayArtifactName,
  isArtifactMediaType,
  type ArtifactDto,
  type ArtifactMediaType,
} from '@shared/artifact.ts';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';
import type { Logger } from '../logger.ts';
import { atomicWriteFile, ensureDir } from './atomic.ts';
import type { StoragePaths } from './paths.ts';

/**
 * What a generation produced, kept where a reader can find it again.
 *
 * `data/<user>/artifacts/<id>/{blob,meta.json}`, shaped like an attachment and
 * governed like a memory: files a person can read, diff and back up, with the
 * directory keeping bytes and metadata together so one removal takes both.
 *
 * The write order is the design, and it is the attachment store's: bytes
 * first, then `meta.json`. A directory without `meta.json` is therefore an
 * import that did not finish, and is invisible to every read — which is what
 * makes a crash halfway leave nothing that looks real.
 *
 * **Artifacts outlive their conversation.** `conversationId` is a back-link and
 * nothing more: deleting a chat leaves its artifacts alone, and a link that no
 * longer resolves is a list entry that cannot offer to go back, not a file
 * that disappears. This is the opposite of an attachment, whose whole life is
 * bound to the message that carries it, and it is the reason the two are not
 * the same store.
 */

const metaSchema = z.strictObject({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  description: z.string().nullable(),
  conversationId: z.string().nullable(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export interface ArtifactMeta {
  id: string;
  ownerId: string;
  name: string;
  mediaType: ArtifactMediaType;
  description: string | null;
  conversationId: string | null;
  size: number;
  createdAt: string;
}

export interface CreateArtifact {
  name: string;
  mediaType: ArtifactMediaType;
  content: string;
  description?: string | undefined;
  conversationId?: string | undefined;
  /** When it was produced, if that is known to be something other than now. */
  createdAt?: string | undefined;
}

/**
 * A ceiling on one artifact.
 *
 * Generous next to a memory, which is prepended to every prompt and so costs
 * context; an artifact costs only disk and is read on request. Bounded all the
 * same, because the content arrives from somebody's export and an unbounded
 * import is an unbounded write.
 */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

export function toArtifactDto(meta: ArtifactMeta): ArtifactDto {
  return {
    id: meta.id,
    name: meta.name,
    mediaType: meta.mediaType,
    ...(meta.description === null ? {} : { description: meta.description }),
    size: meta.size,
    createdAt: meta.createdAt,
    ...(meta.conversationId === null ? {} : { conversationId: meta.conversationId }),
  };
}

export class ArtifactStore {
  readonly #paths: StoragePaths;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(paths: StoragePaths, logger: Logger, options: { now?: () => Date } = {}) {
    this.#paths = paths;
    this.#logger = logger;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Every artifact this reader owns, newest first — the order a list wants. */
  async list(userId: string): Promise<ArtifactMeta[]> {
    const dir = this.#paths.artifactsDir(userId);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    const artifacts: ArtifactMeta[] = [];
    for (const entry of entries) {
      // A name this application would never have written is left alone rather
      // than served back under an id the API cannot address.
      if (!entry.isDirectory() || !isCanonicalUuid(entry.name)) continue;

      const meta = await this.#readOrNull(userId, entry.name);
      if (meta !== null) artifacts.push(meta);
    }

    return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async read(userId: string, artifactId: string): Promise<ArtifactMeta> {
    const meta = await this.#readOrNull(userId, artifactId);
    if (meta === null) throw AppError.notFound('Artifact not found.');
    return meta;
  }

  /** The source, as written. Never served as anything a browser will run. */
  async content(userId: string, artifactId: string): Promise<string> {
    await this.read(userId, artifactId);
    try {
      return await readFile(this.#paths.artifactBlob(userId, artifactId), 'utf8');
    } catch {
      throw AppError.notFound('Artifact not found.');
    }
  }

  async create(userId: string, input: CreateArtifact): Promise<ArtifactMeta> {
    const size = Buffer.byteLength(input.content);
    if (input.content.trim() === '') {
      throw AppError.validation('An artifact cannot be empty.');
    }
    if (size > ARTIFACT_MAX_BYTES) {
      throw AppError.validation(`An artifact is at most ${ARTIFACT_MAX_BYTES / 1024 / 1024}MB.`);
    }
    if (!isArtifactMediaType(input.mediaType)) {
      throw AppError.validation('That is not a media type an artifact may be stored as.');
    }

    const id = randomUUID();
    const description = (input.description ?? '').trim();

    const meta: ArtifactMeta = {
      id,
      ownerId: userId,
      name: displayArtifactName(input.name),
      mediaType: input.mediaType,
      description:
        description === '' ? null : description.slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH),
      conversationId: input.conversationId ?? null,
      size,
      createdAt: input.createdAt ?? this.#now().toISOString(),
    };

    await ensureDir(this.#paths.artifactDir(userId, id));
    // Bytes first, metadata last: the metadata is the completion marker.
    await atomicWriteFile(this.#paths.artifactBlob(userId, id), input.content);
    await atomicWriteFile(this.#paths.artifactMetaFile(userId, id), JSON.stringify(meta, null, 2));

    this.#logger.info('Artifact written', { userId, artifactId: id, size });
    return meta;
  }

  /** Removes one. Resolves to whether there was anything to remove. */
  async remove(userId: string, artifactId: string): Promise<boolean> {
    if (!isCanonicalUuid(artifactId)) return false;
    if ((await this.#readOrNull(userId, artifactId)) === null) return false;

    await rm(this.#paths.artifactDir(userId, artifactId), { recursive: true, force: true });
    this.#logger.info('Artifact removed', { userId, artifactId });
    return true;
  }

  /** What this reader's artifacts occupy, for a quota or a settings page. */
  async totalBytes(userId: string): Promise<number> {
    const artifacts = await this.list(userId);
    return artifacts.reduce((total, artifact) => total + artifact.size, 0);
  }

  /**
   * Metadata, or `null` for anything that is not a complete artifact of this
   * reader's.
   *
   * Ownership is checked against the metadata as well as the path. The path
   * already contains the user's directory, so this is belt and braces — but it
   * is the check that survives somebody moving a directory by hand, and a
   * mismatch reads as "not found" rather than revealing that it exists.
   */
  async #readOrNull(userId: string, artifactId: string): Promise<ArtifactMeta | null> {
    if (!isCanonicalUuid(artifactId)) return null;

    let raw: string;
    try {
      raw = await readFile(this.#paths.artifactMetaFile(userId, artifactId), 'utf8');
    } catch {
      return null;
    }

    let parsed;
    try {
      parsed = metaSchema.safeParse(JSON.parse(raw));
    } catch {
      this.#logger.warn('Artifact metadata is not readable JSON', { userId, artifactId });
      return null;
    }

    if (!parsed.success || !isArtifactMediaType(parsed.data.mediaType)) return null;
    if (parsed.data.ownerId !== userId || parsed.data.id !== artifactId) return null;

    // The blob is what the metadata describes; without it there is no artifact.
    const present = await stat(this.#paths.artifactBlob(userId, artifactId)).catch(() => null);
    if (present === null) return null;

    return { ...parsed.data, mediaType: parsed.data.mediaType };
  }
}
