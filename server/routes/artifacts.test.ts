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
import { ArtifactStore } from '../storage/artifacts.ts';

/**
 * The artifact routes over real HTTP.
 *
 * An HTTP test rather than a unit test for the same reason the attachment one
 * is: what keeps an artifact's bytes from executing in the reader's session is
 * entirely a property of the response, and nothing below the route layer can be
 * asked about it.
 */

const logger = createLogger({ level: 'error', write: () => undefined });

let dataDir: string;
let server: Server | undefined;
let base: string;
let artifacts: ArtifactStore;
let owner: TestClient;
let other: TestClient;
let ownerId: string;

const PAGE = '<!DOCTYPE html>\n<script>alert(1)</script>\n';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'artifact-routes-'));
  const paths = new StoragePaths(dataDir);

  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });
  artifacts = new ArtifactStore(paths, logger);

  const app = createApp({
    logger,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    artifacts,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const one = await users.create({ username: 'owner', password: 'a-good-password' });
  const two = await users.create({ username: 'other', password: 'another-password' });
  ownerId = one.id;
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

async function given(name = 'test-artifact'): Promise<string> {
  const meta = await artifacts.create(ownerId, {
    name,
    mediaType: 'text/html',
    content: PAGE,
    description: 'A counter',
  });
  return meta.id;
}

describe('listing', () => {
  it('serves what this reader has, and nothing of anyone else', async () => {
    const id = await given();

    const mine = (await (await owner.fetch('/api/artifacts')).json()) as {
      artifacts: { id: string; name: string; description?: string }[];
    };
    expect(mine.artifacts).toHaveLength(1);
    expect(mine.artifacts[0]).toMatchObject({
      id,
      name: 'test-artifact',
      description: 'A counter',
    });

    const theirs = (await (await other.fetch('/api/artifacts')).json()) as { artifacts: unknown[] };
    expect(theirs.artifacts).toEqual([]);
  });

  it('needs a session', async () => {
    const response = await fetch(`${base}/api/artifacts`);
    expect(response.status).toBe(401);
  });
});

describe('reading one', () => {
  it('serves the metadata', async () => {
    const id = await given();

    const response = await owner.fetch(`/api/artifacts/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, mediaType: 'text/html' });
  });

  it('is not found for another reader, rather than forbidden', async () => {
    // Ownership is never revealed: "yours or nobody's" is one answer.
    const id = await given();
    expect((await other.fetch(`/api/artifacts/${id}`)).status).toBe(404);
  });

  it('is not found for an id that is not a UUID', async () => {
    expect((await owner.fetch('/api/artifacts/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });
});

/*
 * The reason this route exists in this shape.
 *
 * An artifact is HTML. Served from this origin under its own media type it
 * would be a scriptable document inside the reader's session, able to read
 * their conversations through the very API that served it. So the stored type
 * is deliberately not used on the wire.
 */
describe('serving the source', () => {
  it('sends HTML as plain text, never as HTML', async () => {
    const id = await given();
    const response = await owner.fetch(`/api/artifacts/${id}/source`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(response.headers.get('content-type')).not.toMatch(/html/);
    expect(await response.text()).toBe(PAGE);
  });

  it('sandboxes it and forbids sniffing, so the type cannot be second-guessed', async () => {
    const id = await given();
    const response = await owner.fetch(`/api/artifacts/${id}/source`);

    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is not cached by anything shared', async () => {
    const id = await given();
    const response = await owner.fetch(`/api/artifacts/${id}/source`);

    expect(response.headers.get('cache-control')).toMatch(/private/);
  });

  it('does not serve another reader the bytes', async () => {
    const id = await given();
    expect((await other.fetch(`/api/artifacts/${id}/source`)).status).toBe(404);
  });
});

describe('deleting', () => {
  it('removes it', async () => {
    const id = await given();

    expect((await owner.fetch(`/api/artifacts/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await owner.fetch(`/api/artifacts/${id}`)).status).toBe(404);
  });

  it('is not found when there was nothing to remove', async () => {
    const response = await owner.fetch('/api/artifacts/11111111-2222-4333-8444-555555555555', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  it('does not let another reader remove it', async () => {
    const id = await given();

    expect((await other.fetch(`/api/artifacts/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await owner.fetch(`/api/artifacts/${id}`)).status).toBe(200);
  });
});

describe('what the browser may not do', () => {
  /*
   * There is no upload route, and its absence is a design decision rather than
   * an omission: artifacts come from generations and imports, and accepting
   * them from a client would be accepting arbitrary HTML into a store whose
   * whole point is that its contents are not arbitrary.
   */
  it('offers no way to create one', async () => {
    const response = await owner.fetch('/api/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'evil', mediaType: 'text/html', content: '<script></script>' }),
    });

    expect(response.status).toBe(404);
  });

  it('offers no way to rewrite one', async () => {
    const id = await given();
    const response = await owner.fetch(`/api/artifacts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'replaced' }),
    });

    expect(response.status).toBe(404);
    expect(await artifacts.content(ownerId, id)).toBe(PAGE);
  });
});
