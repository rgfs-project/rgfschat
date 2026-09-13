import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, ARTIFACT_MAX_BYTES, toArtifactDto } from './artifacts.ts';
import { StoragePaths } from './paths.ts';
import type { Logger } from '../logger.ts';

/**
 * The artifact store.
 *
 * The behaviour worth pinning down is what makes an artifact *not* an
 * attachment: it outlives its conversation, it is never served as something a
 * browser will run, and a half-written one is invisible rather than broken.
 */

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const USER = '919b2657-be72-47eb-b704-8bd035b8133c';
const OTHER = '0b7e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

let dataDir: string;
let paths: StoragePaths;
let artifacts: ArtifactStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'artifact-store-'));
  paths = new StoragePaths(dataDir);
  artifacts = new ArtifactStore(paths, logger);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const page = (name = 'test-artifact') => ({
  name,
  mediaType: 'text/html' as const,
  content: '<!DOCTYPE html>\n<p>hello</p>\n',
});

describe('creating', () => {
  it('keeps the source byte for byte', async () => {
    const meta = await artifacts.create(USER, page());

    expect(await artifacts.content(USER, meta.id)).toBe(page().content);
    expect(meta.size).toBe(Buffer.byteLength(page().content));
  });

  it('stores the bytes and the metadata side by side, under one directory', async () => {
    const meta = await artifacts.create(USER, page());

    const entries = await readdir(paths.artifactDir(USER, meta.id));
    expect(entries.sort()).toEqual(['blob', 'meta.json']);
  });

  it('keeps a description and a back-link when it has them', async () => {
    const meta = await artifacts.create(USER, {
      ...page(),
      description: 'A counter',
      conversationId: OTHER,
    });

    expect(toArtifactDto(meta)).toMatchObject({
      description: 'A counter',
      conversationId: OTHER,
    });
  });

  it('omits a description and a back-link it does not have', async () => {
    const dto = toArtifactDto(await artifacts.create(USER, page()));

    expect(dto).not.toHaveProperty('description');
    expect(dto).not.toHaveProperty('conversationId');
  });

  it('never lets a name become a location', async () => {
    const meta = await artifacts.create(USER, { ...page(), name: '../../etc/passwd' });

    // The id is what addresses the directory; the name is display only.
    expect(meta.name).not.toContain('/');
    expect(await readdir(paths.artifactsDir(USER))).toEqual([meta.id]);
  });

  it('takes the time it was produced, so an import is not backdated to now', async () => {
    const meta = await artifacts.create(USER, {
      ...page(),
      createdAt: '2026-09-12T08:26:54.560Z',
    });

    expect(meta.createdAt).toBe('2026-09-12T08:26:54.560Z');
  });

  it('refuses one that is empty, or larger than the ceiling', async () => {
    await expect(artifacts.create(USER, { ...page(), content: '   ' })).rejects.toThrow(/empty/i);
    await expect(
      artifacts.create(USER, { ...page(), content: 'x'.repeat(ARTIFACT_MAX_BYTES + 1) })
    ).rejects.toThrow(/at most/i);
  });

  it('refuses a media type it has no way to present', async () => {
    await expect(
      artifacts.create(USER, { ...page(), mediaType: 'application/x-msdownload' as never })
    ).rejects.toThrow(/media type/i);
  });
});

describe('listing and reading', () => {
  it('lists newest first, which is the order the list is read in', async () => {
    await artifacts.create(USER, { ...page('older'), createdAt: '2026-09-01T00:00:00.000Z' });
    await artifacts.create(USER, { ...page('newer'), createdAt: '2026-09-20T00:00:00.000Z' });

    expect((await artifacts.list(USER)).map((a) => a.name)).toEqual(['newer', 'older']);
  });

  it("does not serve one reader another reader's artifact", async () => {
    const meta = await artifacts.create(USER, page());

    await expect(artifacts.read(OTHER, meta.id)).rejects.toThrow(/not found/i);
    expect(await artifacts.list(OTHER)).toEqual([]);
  });

  it('reports a missing artifact as not found rather than as an error', async () => {
    await expect(artifacts.read(USER, '11111111-2222-4333-8444-555555555555')).rejects.toThrow(
      /not found/i
    );
  });

  it('treats an id that is not a UUID as not found, never as a path', async () => {
    await expect(artifacts.read(USER, '../../../etc/passwd')).rejects.toThrow(/not found/i);
  });

  /*
   * The metadata is the completion marker, exactly as it is for an attachment.
   * An import that died between the two writes leaves a directory that reads
   * as nothing at all, rather than as an artifact with no source.
   */
  it('ignores a directory whose metadata never landed', async () => {
    const meta = await artifacts.create(USER, page());
    await rm(paths.artifactMetaFile(USER, meta.id));

    expect(await artifacts.list(USER)).toEqual([]);
    await expect(artifacts.read(USER, meta.id)).rejects.toThrow(/not found/i);
  });

  it('ignores metadata whose bytes are gone', async () => {
    const meta = await artifacts.create(USER, page());
    await rm(paths.artifactBlob(USER, meta.id));

    expect(await artifacts.list(USER)).toEqual([]);
  });

  it('ignores unreadable metadata rather than failing the whole list', async () => {
    const good = await artifacts.create(USER, page('good'));
    const bad = await artifacts.create(USER, page('bad'));
    await writeFile(paths.artifactMetaFile(USER, bad.id), 'not json');

    expect((await artifacts.list(USER)).map((a) => a.id)).toEqual([good.id]);
  });

  it('leaves a directory it did not write alone', async () => {
    await artifacts.create(USER, page());
    const stray = join(paths.artifactsDir(USER), 'not-a-uuid');
    await mkdtemp(stray);

    expect(await artifacts.list(USER)).toHaveLength(1);
  });
});

describe('removing', () => {
  it('takes the bytes with the metadata', async () => {
    const meta = await artifacts.create(USER, page());

    expect(await artifacts.remove(USER, meta.id)).toBe(true);
    expect(await readdir(paths.artifactsDir(USER))).toEqual([]);
  });

  it('says so when there was nothing to remove', async () => {
    expect(await artifacts.remove(USER, '11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(await artifacts.remove(USER, 'nonsense')).toBe(false);
  });

  it("does not let one reader remove another reader's artifact", async () => {
    const meta = await artifacts.create(USER, page());

    expect(await artifacts.remove(OTHER, meta.id)).toBe(false);
    expect(await artifacts.read(USER, meta.id)).toMatchObject({ id: meta.id });
  });
});

describe('accounting', () => {
  it('adds up what a reader is storing', async () => {
    await artifacts.create(USER, page('one'));
    await artifacts.create(USER, page('two'));

    expect(await artifacts.totalBytes(USER)).toBe(Buffer.byteLength(page().content) * 2);
  });

  it('is zero for a reader with none', async () => {
    expect(await artifacts.totalBytes(USER)).toBe(0);
  });
});
