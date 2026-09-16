import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoragePaths } from '../storage/paths.ts';
import { AttachmentStore } from './store.ts';

/**
 * A quota that only holds when uploads arrive one at a time is not a quota.
 *
 * Each upload read the account's stored total once, at the start, and checked
 * its own growing size against that number. Two uploads starting together both
 * read the same total — neither can see the other, because neither has written
 * anything yet — and both concluded there was room. The limit was enforced
 * against a figure that was already out of date by the time it mattered.
 *
 * The check that decides has to happen where the bytes actually land.
 */

const USER = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const QUOTA = 1_024;

async function* text(size: number): AsyncGenerator<Uint8Array> {
  // One tick, so two uploads genuinely interleave rather than each running to
  // completion before the other starts — which is the whole point here.
  await Promise.resolve();
  yield new Uint8Array(Buffer.from('a'.repeat(size), 'utf8'));
}

let dataDir: string;
let store: AttachmentStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-quota-race-'));
  store = new AttachmentStore(new StoragePaths(dataDir), () => ({
    maxBytes: 1_000_000,
    maxTotalBytesPerUser: QUOTA,
    pendingTtlMs: 3_600_000,
    maxInlineChars: 1000,
    maxImagePixels: 1_000_000,
  }));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('uploads arriving together', () => {
  it('cannot between them exceed the account quota', async () => {
    const results = await Promise.allSettled([
      store.create(USER, 'one.txt', text(800)),
      store.create(USER, 'two.txt', text(800)),
    ]);

    const stored = results.filter((r) => r.status === 'fulfilled');
    expect(stored).toHaveLength(1);
    expect(await store.totalBytes(USER)).toBeLessThanOrEqual(QUOTA);
  });

  it('holds under many at once', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => store.create(USER, `f${i}.txt`, text(300)))
    );

    const stored = results.filter((r) => r.status === 'fulfilled').length;
    // 300 bytes each into 1024: three fit, the fourth does not.
    expect(stored).toBe(3);
    expect(await store.totalBytes(USER)).toBeLessThanOrEqual(QUOTA);
  });

  /** A refusal must not leave its bytes behind to be counted later. */
  it('leaves nothing on disk for the uploads it refused', async () => {
    await Promise.allSettled([
      store.create(USER, 'one.txt', text(800)),
      store.create(USER, 'two.txt', text(800)),
    ]);

    const listed = await store.list(USER);
    const total = listed.reduce((sum, meta) => sum + meta.size, 0);
    expect(total).toBe(await store.totalBytes(USER));
    expect(total).toBeLessThanOrEqual(QUOTA);
  });

  /** Sequential uploads keep behaving exactly as before. */
  it('still admits uploads that genuinely fit', async () => {
    await store.create(USER, 'one.txt', text(500));
    await store.create(USER, 'two.txt', text(500));
    expect(await store.totalBytes(USER)).toBe(1000);

    await expect(store.create(USER, 'three.txt', text(500))).rejects.toThrow();
  });
});
