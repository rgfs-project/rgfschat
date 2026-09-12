import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  displayFilename,
  isAcceptedMediaType,
  kindOf,
  type AcceptedMediaType,
  type AttachmentDto,
  type AttachmentKind,
} from '@shared/attachment.ts';
import { isCanonicalUuid } from '@shared/conversation.ts';
import { AppError } from '../errors/AppError.ts';
import {
  DIR_MODE,
  FILE_MODE,
  atomicWriteFile,
  commitTempFile,
  ensureDir,
  tempPathFor,
} from '../storage/atomic.ts';
import { KeyedLock } from '../storage/locks.ts';
import type { StoragePaths } from '../storage/paths.ts';
import { imageDimensions } from './dimensions.ts';
import { sniff } from './sniff.ts';

/**
 * Attachment storage.
 *
 * The write order is the design: bytes first, then `meta.json`. A directory
 * with no `meta.json` is therefore an upload that did not finish — it is
 * removed at startup, and it is never visible in between, because every read
 * goes through the metadata. Nothing has to remember whether a blob is real.
 *
 * An attachment is **pending** until the message referencing it is written, and
 * **linked** afterwards. Pending is the garbage-collectable state: a reader who
 * attaches a file and then closes the tab has left bytes nobody will ever
 * reference, and nothing else distinguishes those from an upload still being
 * composed.
 */

/** Metadata as it is stored. `ownerId` is here so a stray file still knows. */
const metaSchema = z.strictObject({
  id: z.string(),
  ownerId: z.string(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  filename: z.string(),
  mediaType: z.string(),
  kind: z.enum(['image', 'text']),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.string(),
});

export interface AttachmentMeta {
  id: string;
  ownerId: string;
  conversationId: string | null;
  messageId: string | null;
  filename: string;
  mediaType: AcceptedMediaType;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface AttachmentLimits {
  /** Per file. Enforced while streaming, not after. */
  maxBytes: number;
  /**
   * The most pixels an image may declare.
   *
   * Separate from the byte limit because they defend against different things.
   * A 100 kB PNG can declare 60 000 x 60 000 and expand to fourteen gigabytes
   * in whatever decodes it; the file is small, so a size limit never fires.
   * What has to be checked is the header's claim.
   */
  maxImagePixels: number;
  /** Across everything one user has stored, pending and linked alike. */
  maxTotalBytesPerUser: number;
  /** How long an unreferenced upload survives before collection. */
  pendingTtlMs: number;
}

/**
 * Where the limits come from, asked fresh on every upload.
 *
 * A function rather than a value because an administrator can change them
 * while the server is running, and a copy taken at construction would keep
 * enforcing the old numbers until a restart — which is exactly the kind of
 * setting that looks saved and is not.
 */
export type LimitSource = AttachmentLimits | (() => AttachmentLimits);

export function toAttachmentDto(meta: AttachmentMeta): AttachmentDto {
  return {
    id: meta.id,
    filename: meta.filename,
    mediaType: meta.mediaType,
    kind: meta.kind,
    size: meta.size,
    createdAt: meta.createdAt,
  };
}

/** A source of bytes, so the caller decides between a request and a buffer. */
export type ByteSource = AsyncIterable<Uint8Array>;

export class AttachmentStore {
  readonly #paths: StoragePaths;
  readonly #limitSource: LimitSource;
  readonly #locks = new KeyedLock();

  constructor(paths: StoragePaths, limits: LimitSource) {
    this.#paths = paths;
    this.#limitSource = limits;
  }

  get #limits(): AttachmentLimits {
    return typeof this.#limitSource === 'function' ? this.#limitSource() : this.#limitSource;
  }

  /** `<user>/<attachment>`, matching the conversation lock's shape. */
  #key(userId: string, attachmentId: string): string {
    return `attachment:${userId}/${attachmentId}`;
  }

  /**
   * Stores an upload.
   *
   * The size limit is enforced **as the bytes arrive**: the first byte past the
   * limit ends the write and removes what was written. Checking afterwards
   * would mean a caller could spend a disk on a request that was always going
   * to be refused, which is the difference between a limit and a receipt.
   *
   * The type is decided from the first chunk, before the rest is accepted, so
   * an unsupported file costs only what it took to recognise it.
   */
  async create(
    userId: string,
    filename: string,
    source: ByteSource
  ): Promise<{ meta: AttachmentMeta }> {
    const id = randomUUID();
    const directory = this.#paths.attachmentDir(userId, id);
    const blob = this.#paths.attachmentBlob(userId, id);
    /*
     * Written to a temp name in the same directory and renamed at the end
     * (contracts §2). The rename is what makes `blob` appear whole or not at
     * all, so nothing can ever read a partial upload under its final name —
     * and a temp file left by a crash is recognisable as one, rather than
     * being indistinguishable from a finished blob that lost its metadata.
     */
    const temp = tempPathFor(blob);

    const shown = displayFilename(filename);
    const used = await this.totalBytes(userId);

    await ensureDir(directory);

    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    let mediaType: AcceptedMediaType | null = null;

    const handle = await open(temp, 'wx', FILE_MODE);
    try {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;

        if (size > this.#limits.maxBytes) {
          throw AppError.payloadTooLarge(
            `Attachments are limited to ${formatBytes(this.#limits.maxBytes)}.`
          );
        }
        if (used + size > this.#limits.maxTotalBytesPerUser) {
          throw new AppError(
            'QUOTA_EXCEEDED',
            `You have used your attachment storage of ${formatBytes(this.#limits.maxTotalBytesPerUser)}.`
          );
        }

        // Enough of the start to identify the file, decided once.
        if (mediaType === null) {
          head = head.length === 0 ? bytes : Buffer.concat([head, bytes]);
          if (head.length >= 512) mediaType = this.#identify(head, shown);
        }

        hash.update(bytes);
        await handle.write(bytes);
      }

      // A file shorter than the sniff window is identified from all of it.
      if (mediaType === null) mediaType = this.#identify(head, shown);

      // Checked once the header is in hand and before the bytes are kept, so a
      // bomb costs only the header it took to recognise it.
      this.#assertRepresentable(mediaType, head);

      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temp, { force: true });
      // Nothing half-written survives a refusal, so no oversized temp file is
      // left behind for a later sweep to find.
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    await handle.close();

    // The bytes become `blob` in one step, before any metadata claims they are
    // there. Order matters: meta.json is still the completion marker, and this
    // guarantees that whenever it exists, a whole blob exists beside it.
    await commitTempFile(temp, blob);

    const meta: AttachmentMeta = {
      id,
      ownerId: userId,
      conversationId: null,
      messageId: null,
      filename: shown,
      mediaType,
      kind: kindOf(mediaType),
      size,
      sha256: hash.digest('hex'),
      createdAt: new Date().toISOString(),
    };

    // Last, and atomically: its presence is what makes the upload complete.
    await atomicWriteFile(
      this.#paths.attachmentMetaFile(userId, id),
      `${JSON.stringify(meta, null, 2)}\n`
    );

    return { meta };
  }

  /**
   * Refuses an image whose declared size is beyond what may be stored.
   *
   * Unreadable dimensions are refused too. `null` from the reader means the
   * header could not be parsed, which is not the same as "small" — an image
   * whose cost cannot be bounded is one this application will not accept,
   * however plausible its magic bytes were.
   */
  #assertRepresentable(mediaType: AcceptedMediaType, head: Buffer): void {
    if (kindOf(mediaType) !== 'image') return;

    const dimensions = imageDimensions(mediaType, new Uint8Array(head));
    if (dimensions === null) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'That image could not be read. It may be damaged or truncated.'
      );
    }

    const pixels = dimensions.width * dimensions.height;
    if (pixels > this.#limits.maxImagePixels) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        `That image is ${dimensions.width}x${dimensions.height}, which is larger than this server will accept.`
      );
    }
  }

  #identify(head: Buffer, filename: string): AcceptedMediaType {
    const result = sniff(new Uint8Array(head), filename);
    if (!result.ok) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', result.reason);
    }
    return result.mediaType;
  }

  /**
   * Reads metadata, or reports the attachment as absent.
   *
   * Cross-user access is indistinguishable from a missing attachment, so
   * ownership is never revealed (contracts §5). The stored `ownerId` is checked
   * as well as the path, because the two agreeing is the invariant and a
   * disagreement means something has been moved by hand.
   */
  async read(userId: string, attachmentId: string): Promise<AttachmentMeta> {
    if (!isCanonicalUuid(attachmentId)) throw AppError.notFound('Attachment not found.');

    let raw: string;
    try {
      raw = await readFile(this.#paths.attachmentMetaFile(userId, attachmentId), 'utf8');
    } catch {
      throw AppError.notFound('Attachment not found.');
    }

    const parsed = metaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !isAcceptedMediaType(parsed.data.mediaType)) {
      throw AppError.notFound('Attachment not found.');
    }
    if (parsed.data.ownerId !== userId || parsed.data.id !== attachmentId) {
      throw AppError.notFound('Attachment not found.');
    }

    return { ...parsed.data, mediaType: parsed.data.mediaType };
  }

  /** The stored bytes. Small enough to hold: the per-file limit is the cap. */
  async bytes(userId: string, attachmentId: string): Promise<Buffer> {
    await this.read(userId, attachmentId);
    return readFile(this.#paths.attachmentBlob(userId, attachmentId));
  }

  blobPath(userId: string, attachmentId: string): string {
    return this.#paths.attachmentBlob(userId, attachmentId);
  }

  /**
   * Marks attachments as belonging to a message.
   *
   * Idempotent for the same message, so the startup reconciliation can link
   * what a crash left pending without having to know whether it already did.
   * Linking to a *different* message is refused: an attachment belongs to one
   * message, and re-linking would leave the first one referencing bytes that
   * now claim to be elsewhere.
   */
  async link(
    userId: string,
    attachmentIds: readonly string[],
    conversationId: string,
    messageId: string
  ): Promise<void> {
    for (const attachmentId of attachmentIds) {
      await this.#locks.run(this.#key(userId, attachmentId), async () => {
        const meta = await this.read(userId, attachmentId);

        if (meta.messageId === messageId && meta.conversationId === conversationId) return;
        if (meta.messageId !== null) {
          throw AppError.validation('That attachment is already part of a message.');
        }

        await atomicWriteFile(
          this.#paths.attachmentMetaFile(userId, attachmentId),
          `${JSON.stringify({ ...meta, conversationId, messageId }, null, 2)}\n`
        );
      });
    }
  }

  /** Every attachment id this user owns that is still pending. */
  async pending(userId: string): Promise<AttachmentMeta[]> {
    const all = await this.list(userId);
    return all.filter((meta) => meta.messageId === null);
  }

  async list(userId: string): Promise<AttachmentMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#paths.attachmentsDir(userId));
    } catch {
      return [];
    }

    const found: AttachmentMeta[] = [];
    for (const entry of entries) {
      if (!isCanonicalUuid(entry)) continue;
      try {
        found.push(await this.read(userId, entry));
      } catch {
        // Incomplete or unreadable: not an attachment yet, and never deleted
        // from here — `sweep` is the only thing that removes anything.
      }
    }
    return found;
  }

  async totalBytes(userId: string): Promise<number> {
    const all = await this.list(userId);
    return all.reduce((sum, meta) => sum + meta.size, 0);
  }

  /**
   * Deletes an attachment, which is only allowed while it is still pending.
   *
   * A linked attachment is referenced by a message in canonical storage, and
   * removing it from under that message would turn a conversation into one
   * with a dangling reference. Conversations own their attachments from the
   * moment they mention them; deleting the conversation is what releases them.
   */
  async delete(userId: string, attachmentId: string): Promise<void> {
    await this.#locks.run(this.#key(userId, attachmentId), async () => {
      const meta = await this.read(userId, attachmentId);
      if (meta.messageId !== null) {
        throw AppError.validation('That attachment is part of a message and cannot be removed.');
      }
      await rm(this.#paths.attachmentDir(userId, attachmentId), { recursive: true, force: true });
    });
  }

  /** Removes attachments by id without asking whether they are linked. */
  async deleteMany(userId: string, attachmentIds: readonly string[]): Promise<void> {
    for (const attachmentId of attachmentIds) {
      if (!isCanonicalUuid(attachmentId)) continue;
      await this.#locks.run(this.#key(userId, attachmentId), async () => {
        await rm(this.#paths.attachmentDir(userId, attachmentId), { recursive: true, force: true });
      });
    }
  }

  /**
   * Startup and periodic housekeeping, for one user.
   *
   * Two jobs that are the same scan: a directory with no `meta.json` is an
   * upload interrupted by a crash, and a pending attachment past its TTL is one
   * nobody is going to reference. Both are removed; nothing else is touched,
   * because an unrecognised entry under `data/` is never this code's to delete
   * (contracts §1).
   */
  async sweep(userId: string, now = Date.now()): Promise<{ incomplete: number; expired: number }> {
    let entries: string[];
    try {
      entries = await readdir(this.#paths.attachmentsDir(userId));
    } catch {
      return { incomplete: 0, expired: 0 };
    }

    let incomplete = 0;
    let expired = 0;

    for (const entry of entries) {
      if (!isCanonicalUuid(entry)) continue;

      const directory = this.#paths.attachmentDir(userId, entry);
      let meta: AttachmentMeta;
      try {
        meta = await this.read(userId, entry);
      } catch {
        /*
         * No readable metadata. Only removed once it is old enough to be a
         * crash rather than an upload in flight — a sweep running while
         * someone is sending a file must not delete it out from under them.
         */
        const age = await directoryAge(directory);
        if (age !== null && now - age > this.#limits.pendingTtlMs) {
          await rm(directory, { recursive: true, force: true });
          incomplete += 1;
        }
        continue;
      }

      if (meta.messageId !== null) continue;
      if (now - Date.parse(meta.createdAt) > this.#limits.pendingTtlMs) {
        await rm(directory, { recursive: true, force: true });
        expired += 1;
      }
    }

    return { incomplete, expired };
  }

  /** Creates the directory with the right mode before anything is written. */
  async ensureUserDir(userId: string): Promise<void> {
    await ensureDir(this.#paths.attachmentsDir(userId));
  }
}

async function directoryAge(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

export { DIR_MODE };
