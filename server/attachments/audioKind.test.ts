import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoragePaths } from '../storage/paths.ts';
import { AttachmentStore } from './store.ts';

/**
 * An audio file that uploads and then is not there.
 *
 * Audio is a supported kind end to end — the media types are accepted, the
 * capability check knows which models can take it, and the upload succeeds.
 * What it was not was *readable*: the schema the metadata is validated against
 * on the way back in listed only `image` and `text`, so every audio attachment
 * failed to parse and was reported as missing. It also vanished from the quota,
 * which is the same bug seen from the accounting side — bytes on disk that the
 * store will not admit to.
 */

/** A minimal RIFF/WAVE header, which is what the type sniffer reads. */
function wav(bytes = 64): Buffer {
  const data = Buffer.alloc(bytes);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, data]);
}

async function* bytesOf(buffer: Buffer): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield new Uint8Array(buffer);
}

const USER = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

let dataDir: string;
let store: AttachmentStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-audio-'));
  store = new AttachmentStore(new StoragePaths(dataDir), () => ({
    maxBytes: 1_000_000,
    maxTotalBytesPerUser: 10_000_000,
    pendingTtlMs: 3_600_000,
    maxInlineChars: 1000,
    maxImagePixels: 1_000_000,
  }));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('an uploaded audio attachment', () => {
  it('is stored as audio', async () => {
    const { meta } = await store.create(USER, 'note.wav', bytesOf(wav()));
    expect(meta.kind).toBe('audio');
    expect(meta.mediaType).toBe('audio/wav');
  });

  /** The headline: what was written can be read back. */
  it('can be read back by id', async () => {
    const { meta } = await store.create(USER, 'note.wav', bytesOf(wav()));

    const found = await store.read(USER, meta.id);
    expect(found.kind).toBe('audio');
    expect(found.id).toBe(meta.id);

    // And the bytes themselves come back, not just the metadata.
    expect((await store.bytes(USER, meta.id)).length).toBe(meta.size);
  });

  it('counts towards the account total, like every other kind', async () => {
    const { meta } = await store.create(USER, 'note.wav', bytesOf(wav()));
    expect(await store.totalBytes(USER)).toBe(meta.size);
  });
});
