import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { StoragePaths } from '../storage/paths.ts';
import { AttachmentStore } from '../attachments/store.ts';
import { pngBytes } from '../attachments/testImages.ts';

/**
 * The attachment routes over real HTTP.
 *
 * The headers are the reason this is an HTTP test rather than a unit test:
 * what keeps stored bytes from executing is entirely a property of the
 * response, and nothing below the route layer can be asked about it.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let server: Server | undefined;
let base: string;
let owner: TestClient;
let other: TestClient;

const PNG = Buffer.from(pngBytes());

/** A multipart body, built by hand so the test controls every byte of it. */
function multipart(
  filename: string,
  content: Buffer,
  declaredType = 'application/octet-stream'
): { body: Buffer; contentType: string } {
  const boundary = '----workspacetest0123456789';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${declaredType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(
  client: TestClient,
  filename: string,
  content: Buffer,
  declaredType?: string
): Promise<Response> {
  const { body, contentType } = multipart(filename, content, declaredType);
  return client.fetch('/api/attachments', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(body),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'attachment-routes-'));
  const paths = new StoragePaths(dataDir);

  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });
  const attachments = new AttachmentStore(paths, {
    maxBytes: 1024,
    maxTotalBytesPerUser: 4096,
    pendingTtlMs: 60_000,
    maxImagePixels: 50_000_000,
  });

  const app = createApp({
    logger,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    attachments,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const one = await users.create({ username: 'owner', password: 'a-good-password' });
  const two = await users.create({ username: 'other', password: 'another-password' });
  owner = await signIn(base, sessions, one.id);
  other = await signIn(base, sessions, two.id);
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe('uploading', () => {
  it('stores a file and describes it', async () => {
    const response = await upload(owner, 'notes.md', Buffer.from('# Title\n', 'utf8'));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      filename: 'notes.md',
      mediaType: 'text/markdown',
      kind: 'text',
      size: 8,
    });
  });

  it('INV-27: believes the bytes, not the declared Content-Type', async () => {
    // Declared as a PNG, named as a PNG, and actually a shell script.
    const response = await upload(
      owner,
      'photo.png',
      Buffer.from('#!/bin/sh\necho hi\n', 'utf8'),
      'image/png'
    );

    expect(response.status).toBe(201);
    // Stored as text, which is what stops it being served back as an image.
    expect(await response.json()).toMatchObject({ mediaType: 'text/plain', kind: 'text' });
  });

  it('refuses an SVG', async () => {
    const response = await upload(
      owner,
      'logo.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8'),
      'image/svg+xml'
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it('refuses a file over the size limit', async () => {
    const response = await upload(owner, 'big.txt', Buffer.alloc(2048, 0x41));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('refuses a request that is not multipart', async () => {
    const response = await owner.fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'nope' }),
    });

    expect(response.status).toBe(400);
  });

  it('refuses a multipart request with no file in it', async () => {
    const boundary = '----empty0123456789';
    const response = await owner.fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${boundary}--\r\n`,
    });

    expect(response.status).toBe(400);
  });
});

describe('serving content', () => {
  it('INV-27: text is sent as a download, sandboxed, and never sniffed', async () => {
    const created = (await (await upload(owner, 'notes.md', Buffer.from('# Hi\n'))).json()) as {
      id: string;
    };

    const response = await owner.fetch(`/api/attachments/${created.id}/content`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('cache-control')).toContain('private');
    // Downloaded, not opened: a text file must never render in the origin.
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(await response.text()).toBe('# Hi\n');
  });

  it('INV-27: HTML disguised as an image is still sent as a download', async () => {
    const created = (await (
      await upload(owner, 'page.png', Buffer.from('#!/bin/sh\n'), 'image/png')
    ).json()) as { id: string };

    const response = await owner.fetch(`/api/attachments/${created.id}/content`);

    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('a real image may be shown in place', async () => {
    const created = (await (await upload(owner, 'photo.png', PNG)).json()) as { id: string };

    const response = await owner.fetch(`/api/attachments/${created.id}/content`);

    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toMatch(/^inline;/);
    // Still sandboxed and still not sniffable.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a filename cannot break out of the Content-Disposition header', async () => {
    /*
     * Sent in the RFC 5987 form. The quoted form cannot carry a quote — busboy
     * stops at the first one, which is exactly why an earlier version of this
     * test proved nothing: the name never reached storage with a quote in it.
     */
    const boundary = '----quoted0123456789';
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename*=UTF-8''evil%22%3Bx%3D%22.txt\r\n` +
        `Content-Type: text/plain\r\n\r\n`,
      'utf8'
    );
    const body = Buffer.concat([head, Buffer.from('x'), Buffer.from(`\r\n--${boundary}--\r\n`)]);

    const created = (await (
      await owner.fetch('/api/attachments', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: new Uint8Array(body),
      })
    ).json()) as { id: string; filename: string };

    // The quote really did survive into storage, or this tests nothing.
    expect(created.filename).toContain('"');

    const response = await owner.fetch(`/api/attachments/${created.id}/content`);
    const header = response.headers.get('content-disposition') ?? '';

    // One quoted segment, then the encoded form. A quote from the name would
    // otherwise close the string early and add a parameter of its choosing.
    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(header).not.toContain('x=".txt');
  });
});

describe('ownership', () => {
  it('INV-15: another user gets 404 for metadata, content and delete alike', async () => {
    const created = (await (await upload(owner, 'secret.txt', Buffer.from('secret'))).json()) as {
      id: string;
    };

    for (const [method, path] of [
      ['GET', `/api/attachments/${created.id}`],
      ['GET', `/api/attachments/${created.id}/content`],
      ['DELETE', `/api/attachments/${created.id}`],
    ] as const) {
      const response = await other.fetch(path, { method });
      // 404 and never 403: the reply must not confirm the id exists.
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    // And it is still there for the person it belongs to.
    expect((await owner.fetch(`/api/attachments/${created.id}`)).status).toBe(200);
  });

  it('an unparseable id is not found rather than an error', async () => {
    expect((await owner.fetch('/api/attachments/not-a-uuid')).status).toBe(404);
  });
});

describe('discarding', () => {
  it('removes a pending attachment', async () => {
    const created = (await (await upload(owner, 'draft.txt', Buffer.from('x'))).json()) as {
      id: string;
    };

    expect((await owner.fetch(`/api/attachments/${created.id}`, { method: 'DELETE' })).status).toBe(
      204
    );
    expect((await owner.fetch(`/api/attachments/${created.id}`)).status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('refuses a flood of uploads with RATE_LIMITED and a Retry-After', async () => {
    /*
     * Sixty per minute is the configured budget. Sent serially rather than in
     * parallel so the counter's order is the request order, and the first
     * refusal is unambiguous.
     */
    let refused: Response | undefined;
    for (let i = 0; i < 65; i += 1) {
      const response = await upload(owner, `f${i}.txt`, Buffer.from('x'));
      if (response.status === 429) {
        refused = response;
        break;
      }
    }

    expect(refused, 'the upload limit never engaged').toBeDefined();
    expect(Number(refused?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused?.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it("one account's flood does not spend another's budget", async () => {
    for (let i = 0; i < 65; i += 1) {
      const response = await upload(owner, `f${i}.txt`, Buffer.from('x'));
      if (response.status === 429) break;
    }

    // The limit is per account, so the other one is untouched.
    expect((await upload(other, 'mine.txt', Buffer.from('x'))).status).toBe(201);
  });
});
