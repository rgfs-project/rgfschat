import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { createLogger } from '../logger.ts';
import { LlamaCppProvider } from '../provider/llamacpp.ts';
import { ProviderHub } from '../provider/hub.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { startMockProvider, type MockProvider } from '../provider/mockServer.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';
import { SESSION_COOKIE, SessionManager } from './sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from './users.ts';
import { readCookie } from './middleware.ts';

const logger = createLogger({ level: 'silent', write: () => {} });

let dataDir: string;
let base: string;
let server: Server | undefined;
let mock: MockProvider | undefined;
let manager: GenerationManager | undefined;
let service: GenerationService | undefined;
let users: UserStore;
let sessions: SessionManager;
let store: ConversationStore;
let provider: LlamaCppProvider;
let hub: ProviderHub;

async function boot(registrationMode: 'closed' | 'open' = 'closed'): Promise<void> {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-auth-'));
  const paths = new StoragePaths(dataDir);

  store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  mock = await startMockProvider({ contentChunks: ['ok'] });
  provider = new LlamaCppProvider(
    {
      baseUrl: mock.url,
      apiKey: undefined,
      timeoutMs: 5_000,
      defaultContextTokens: 8_192,
      maxOutputTokens: 128,
    },
    logger
  );
  manager = new GenerationManager({ provider, logger, maxOutputTokens: 128 });
  hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    factory: () => provider,
  });
  hub.setProviders([
    {
      id: 'local',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: mock?.url ?? 'http://127.0.0.1:1',
      timeoutMs: 5_000,
      capabilities: {},
    },
  ]);
  service = new GenerationService({
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
  });

  const app = createApp({
    logger,
    hub,
    manager,
    store,
    index,
    service,
    users,
    sessions,
    authConfig: { registrationMode, absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await service?.allSettled();
  manager?.shutdown();
  manager = undefined;
  service = undefined;
  if (server !== undefined) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await mock?.close();
  mock = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

/** A signed-in client, obtained through the real login route. */
interface Client {
  userId: string;
  cookie: string;
  csrf: string;
  call: (path: string, init?: RequestInit) => Promise<Response>;
}

async function signInAs(username: string, password = 'correct horse battery'): Promise<Client> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);

  const body = (await response.json()) as { user: { id: string }; csrfToken: string };
  const token = readCookie(response.headers.get('set-cookie') ?? undefined, SESSION_COOKIE);
  const cookie = `${SESSION_COOKIE}=${token ?? ''}`;

  return {
    userId: body.user.id,
    cookie,
    csrf: body.csrfToken,
    call: (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken, ...init.headers },
      }),
  };
}

async function createUser(username: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const user = await users.create({ username, password: 'correct horse battery', role });
  return user.id;
}

describe('accounts', () => {
  beforeEach(() => boot());

  it('INV-03: no response ever contains a password hash', async () => {
    await createUser('ada');
    const client = await signInAs('ada');

    for (const path of ['/api/auth/session', '/api/conversations']) {
      const text = await (await client.call(path)).text();
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('$argon2');
    }

    // And it is genuinely stored, so the assertion above is not vacuous.
    const raw = await readFile(join(dataDir, client.userId, 'user.json'), 'utf8');
    expect(raw).toContain('$argon2id$');
  });

  it('enforces case-insensitive username uniqueness', async () => {
    await createUser('ada');

    await expect(
      users.create({ username: 'ADA', password: 'correct horse battery' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      users.create({ username: 'Ada', password: 'correct horse battery' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('holds the registry lock so concurrent registrations cannot both win', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        users.create({ username: 'racer', password: 'correct horse battery' })
      )
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await users.list()).filter((u) => u.username === 'racer')).toHaveLength(1);
  });

  it('rejects invalid usernames', async () => {
    for (const bad of ['ab', 'x'.repeat(33), 'has space', 'Ünicode', 'semi;colon']) {
      await expect(
        users.create({ username: bad, password: 'correct horse battery' })
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
  });

  it('rebuilds the derived username registry from canonical records', async () => {
    await createUser('ada');
    await createUser('grace');

    await rm(join(dataDir, '_system', 'users.index.json'));

    // The canonical user.json files are the authority.
    expect(await users.findByUsername('grace')).not.toBeNull();
    expect(Object.keys(await users.rebuildRegistry()).sort()).toEqual(['ada', 'grace']);
  });
});

describe('sessions', () => {
  beforeEach(() => boot());

  it('stores only the hash of the token', async () => {
    await createUser('ada');
    const client = await signInAs('ada');
    const token = client.cookie.split('=')[1] ?? '';

    const files = await (
      await import('node:fs/promises')
    ).readdir(join(dataDir, '_system', 'sessions'));
    expect(files).toHaveLength(1);
    // The filename is a digest, and the raw token appears nowhere on disk.
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const contents = await readFile(
      join(dataDir, '_system', 'sessions', files[0] as string),
      'utf8'
    );
    expect(contents).not.toContain(token);
  });

  it('sets an HttpOnly, SameSite=Lax cookie', async () => {
    await createUser('ada');
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'ada', password: 'correct horse battery' }),
    });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('rotates the token on login, defeating fixation', async () => {
    await createUser('ada');
    const first = await signInAs('ada');
    const second = await signInAs('ada');

    expect(first.cookie).not.toBe(second.cookie);
  });

  it('logout invalidates the token server-side', async () => {
    await createUser('ada');
    const client = await signInAs('ada');

    expect((await client.call('/api/conversations')).status).toBe(200);
    expect((await client.call('/api/auth/logout', { method: 'POST' })).status).toBe(204);

    // A copied token must stop working, not merely be cleared from the browser.
    expect((await client.call('/api/conversations')).status).toBe(401);
  });

  it('INV-17: disabling a user takes effect on the very next request', async () => {
    const id = await createUser('ada');
    const client = await signInAs('ada');
    expect((await client.call('/api/conversations')).status).toBe(200);

    await users.update(id, { status: 'disabled' });

    // No re-login required: the record is loaded on every request.
    expect((await client.call('/api/conversations')).status).toBe(401);
  });

  it('INV-17: a role change takes effect on the next request', async () => {
    const id = await createUser('ada');
    const client = await signInAs('ada');

    expect((await (await client.call('/api/auth/session')).json()).user.role).toBe('user');
    await users.update(id, { role: 'admin' });
    expect((await (await client.call('/api/auth/session')).json()).user.role).toBe('admin');
  });

  it('changing a password revokes every other session', async () => {
    await createUser('ada');
    const stale = await signInAs('ada');
    const current = await signInAs('ada');

    const res = await current.call('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'correct horse battery',
        newPassword: 'a brand new passphrase',
      }),
    });
    expect(res.status).toBe(204);

    expect((await stale.call('/api/conversations')).status).toBe(401);
    expect((await current.call('/api/conversations')).status).toBe(200);
  });

  it('rejects a password change with the wrong current password', async () => {
    await createUser('ada');
    const client = await signInAs('ada');

    const res = await client.call('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'a brand new passphrase' }),
    });
    expect(res.status).toBe(401);
  });

  it('expires a session past its absolute deadline', async () => {
    const id = await createUser('ada');
    let clock = new Date('2026-09-11T00:00:00.000Z');
    const shortLived = new SessionManager({
      paths: store.paths,
      logger,
      absoluteTtlMs: 1_000,
      idleTtlMs: 1_000,
      now: () => clock,
    });

    const session = await shortLived.create(id);
    expect(await shortLived.resolve(session.token)).not.toBeNull();

    clock = new Date(clock.getTime() + 5_000);
    expect(await shortLived.resolve(session.token)).toBeNull();
  });

  it('expires an idle session while sliding the window on use', async () => {
    const id = await createUser('ada');
    let clock = new Date('2026-09-11T00:00:00.000Z');
    const manager2 = new SessionManager({
      paths: store.paths,
      logger,
      absoluteTtlMs: 3_600_000,
      idleTtlMs: 1_000,
      now: () => clock,
    });

    const session = await manager2.create(id);
    // Using it before the idle deadline pushes the deadline forward.
    clock = new Date(clock.getTime() + 800);
    expect(await manager2.resolve(session.token)).not.toBeNull();
    clock = new Date(clock.getTime() + 800);
    expect(await manager2.resolve(session.token)).not.toBeNull();

    // Leaving it alone past the window kills it.
    clock = new Date(clock.getTime() + 5_000);
    expect(await manager2.resolve(session.token)).toBeNull();
  });
});

describe('authorization', () => {
  beforeEach(() => boot());

  /**
   * Every protected route, **enumerated from the router itself**.
   *
   * A hand-maintained list would silently stop covering a route added later —
   * exactly the case this is meant to catch. Walking the Express stack means a
   * new unguarded route fails this test the moment it is mounted.
   */
  function enumerateRoutes(): [string, string][] {
    const app = createApp({
      logger,
      users,
      sessions,
      store,
      index: new ChatIndex({ store, logger }),
      ...(service === undefined ? {} : { service }),
      hub,
      ...(manager === undefined ? {} : { manager }),
      authConfig: { registrationMode: 'closed', absoluteTtlMs: 1, idleTtlMs: 1 },
    });

    const router = (app as unknown as { router?: { stack?: unknown[] } }).router;
    const found: [string, string][] = [];

    for (const layer of router?.stack ?? []) {
      const nested = (layer as { handle?: { stack?: unknown[] } }).handle?.stack;
      if (!Array.isArray(nested)) continue;

      for (const inner of nested) {
        const route = (inner as { route?: { path: string; methods: Record<string, boolean> } })
          .route;
        if (route === undefined) continue;

        for (const method of Object.keys(route.methods)) {
          const path = `/api${route.path}`;
          // Auth and health are deliberately public.
          if (path.startsWith('/api/auth/') || path === '/api/health') continue;
          found.push([method.toUpperCase(), path]);
        }
      }
    }
    return found;
  }

  /** Fills route params with syntactically valid ids so only auth can reject. */
  function concrete(path: string): string {
    return path.replace(/:[A-Za-z]+/g, () => randomUUID());
  }

  it('enumerates a plausible number of protected routes', () => {
    const routes = enumerateRoutes();
    // Guards against the enumeration silently finding nothing.
    expect(routes.length).toBeGreaterThanOrEqual(10);
    expect(routes.some(([, path]) => path.startsWith('/api/conversations'))).toBe(true);
    expect(routes.some(([, path]) => path.startsWith('/api/generations'))).toBe(true);
  });

  it('every enumerated route requires authentication', async () => {
    const unguarded: string[] = [];

    for (const [method, path] of enumerateRoutes()) {
      const response = await fetch(`${base}${concrete(path)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
      });
      if (response.status !== 401) unguarded.push(`${method} ${path} → ${response.status}`);
    }

    expect(unguarded).toEqual([]);
  });

  it('INV-16: every enumerated state-changing route requires a CSRF token', async () => {
    await createUser('ada');
    const client = await signInAs('ada');

    const unguarded: string[] = [];
    for (const [method, path] of enumerateRoutes()) {
      if (method === 'GET' || method === 'HEAD') continue;

      const response = await fetch(`${base}${concrete(path)}`, {
        method,
        headers: { Cookie: client.cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (response.status !== 403) unguarded.push(`${method} ${path} → ${response.status}`);
    }

    expect(unguarded).toEqual([]);
  });

  it('rejects a CSRF token belonging to a different session', async () => {
    await createUser('ada');
    await createUser('grace');
    const ada = await signInAs('ada');
    const grace = await signInAs('grace');

    const response = await fetch(`${base}/api/conversations`, {
      method: 'POST',
      headers: {
        Cookie: ada.cookie,
        'X-CSRF-Token': grace.csrf,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(403);
  });

  it('leaves public routes open', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/auth/session`)).status).toBe(200);
  });

  it('reports an anonymous caller as signed out', async () => {
    const body = (await (await fetch(`${base}/api/auth/session`)).json()) as {
      user: null;
      csrfToken: null;
    };
    expect(body.user).toBeNull();
    expect(body.csrfToken).toBeNull();
  });
});

describe('INV-15: users cannot reach each other', () => {
  beforeEach(() => boot());

  it('a conversation is invisible to everyone but its owner', async () => {
    await createUser('ada');
    await createUser('grace');
    const ada = await signInAs('ada');
    const grace = await signInAs('grace');

    const created = await (
      await ada.call('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Ada private' }),
      })
    ).json();
    const id = (created as { id: string }).id;

    // Not listed…
    expect((await (await grace.call('/api/conversations')).json()).conversations).toEqual([]);

    // …and every operation reports 404, never 403, so ownership is not revealed.
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', JSON.stringify({ title: 'stolen' })],
      ['DELETE', undefined],
    ] as [string, string | undefined][]) {
      const response = await grace.call(`/api/conversations/${id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(404);
    }

    // Ada's conversation is untouched by all of that.
    expect((await ada.call(`/api/conversations/${id}`)).status).toBe(200);
  });

  it('INV-14: a request cannot choose its own identity via header or body', async () => {
    await createUser('ada');
    await createUser('grace');
    const ada = await signInAs('ada');
    const graceId = await signInAs('grace').then((g) => g.userId);

    // Ada owns this.
    const created = await (
      await ada.call('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Ada private' }),
      })
    ).json();
    const id = (created as { id: string }).id;

    /*
     * Ada's session, but every request-controlled field that might carry an
     * identity set to Grace's id. Identity comes only from the session
     * (INV-14), so all of this is inert: the conversation still lists for Ada
     * and the spoofed owner reaches nothing of Grace's.
     */
    const spoof = {
      'X-User': graceId,
      'X-User-Id': graceId,
      'X-Auth-User': graceId,
    };
    const listed = await (await ada.call('/api/conversations', { headers: spoof })).json();
    expect((listed as { conversations: { id: string }[] }).conversations.map((c) => c.id)).toEqual([
      id,
    ]);

    // A body that names another user is a rejected unknown field, not an
    // identity — the schema is strict, so this never even reaches a handler.
    const withBody = await ada.call('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...spoof },
      body: JSON.stringify({ title: 'x', userId: graceId, ownerId: graceId }),
    });
    expect(withBody.status).toBe(400);
  });

  it('a generation cannot be observed or cancelled by another user', async () => {
    await createUser('ada');
    await createUser('grace');
    const ada = await signInAs('ada');
    const grace = await signInAs('grace');

    const created = (await (
      await ada.call('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).json()) as { id: string };

    const started = (await (
      await ada.call('/api/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: created.id,
          providerId: 'local',
          model: 'GPT',
          content: 'hello',
        }),
      })
    ).json()) as { generationId: string };

    for (const path of [
      `/api/generations/${started.generationId}`,
      `/api/generations/${started.generationId}/stream`,
    ]) {
      expect((await grace.call(path)).status).toBe(404);
    }
    expect(
      (await grace.call(`/api/generations/${started.generationId}/cancel`, { method: 'POST' }))
        .status
    ).toBe(404);

    // The owner can still see it.
    expect((await ada.call(`/api/generations/${started.generationId}`)).status).toBe(200);
    await service?.allSettled();
  });

  it('each user gets their own storage directory', async () => {
    await createUser('ada');
    await createUser('grace');
    const ada = await signInAs('ada');
    const grace = await signInAs('grace');

    for (const client of [ada, grace]) {
      await client.call('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }

    expect(await store.listIds(ada.userId)).toHaveLength(1);
    expect(await store.listIds(grace.userId)).toHaveLength(1);
    expect(await store.listIds(ada.userId)).not.toEqual(await store.listIds(grace.userId));
  });
});

describe('registration', () => {
  it('is closed by default once an account exists', async () => {
    await boot('closed');
    await createUser('ada');

    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'newbie', password: 'correct horse battery' }),
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('REGISTRATION_CLOSED');
  });

  // A fresh instance has no shell-only escape hatch to create the first
  // account, so registration opens for exactly that one signup regardless of
  // the configured mode — and hands it the admin role, since nobody else
  // could have set one up.
  it('opens for the very first account on a fresh instance', async () => {
    await boot('closed');

    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'newbie', password: 'correct horse battery' }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).user.role).toBe('admin');
  });

  it('closes again once that first account exists', async () => {
    await boot('closed');

    await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'first', password: 'correct horse battery' }),
    });

    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'second', password: 'correct horse battery' }),
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('REGISTRATION_CLOSED');
  });

  it('creates an account and signs in when open', async () => {
    await boot('open');

    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'newbie', password: 'correct horse battery' }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    const body = await response.json();
    expect(body.user.username).toBe('newbie');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('INV-16: rejects a cross-origin login', async () => {
    await boot();
    await createUser('ada');

    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ username: 'ada', password: 'correct horse battery' }),
    });

    expect(response.status).toBe(403);
  });

  it('does not reveal whether a username exists', async () => {
    await boot();
    await createUser('ada');

    const wrongPassword = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'ada', password: 'not the password' }),
    });
    const noSuchUser = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'nobody', password: 'not the password' }),
    });

    expect(wrongPassword.status).toBe(noSuchUser.status);
    expect(await wrongPassword.text()).toBe(await noSuchUser.text());
  });

  it('rejects a disabled account exactly like a wrong password', async () => {
    await boot();
    const id = await createUser('ada');
    await users.update(id, { status: 'disabled' });

    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username: 'ada', password: 'correct horse battery' }),
    });

    expect(response.status).toBe(401);
  });
});

describe('adopting Phase 3 local data (contracts §6)', () => {
  beforeEach(() => boot());

  const LOCAL_USER_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

  it('--adopt-local-data hands the existing directory to the new account', async () => {
    // Pre-existing single-user data, as Phase 3 would have left it.
    await store.init(LOCAL_USER_ID);
    const { id: conversationId } = await store.create(LOCAL_USER_ID, 'From before accounts');

    const user = await users.create({
      username: 'adopter',
      password: 'correct horse battery',
      role: 'admin',
      id: LOCAL_USER_ID,
    });

    // Same id means the directory simply becomes theirs — nothing moves.
    expect(user.id).toBe(LOCAL_USER_ID);
    expect(await store.listIds(user.id)).toEqual([conversationId]);
    expect((await store.load(user.id, conversationId)).title).toBe('From before accounts');
  });

  it('without the flag, existing local data is left untouched and unowned', async () => {
    await store.init(LOCAL_USER_ID);
    const { id: conversationId } = await store.create(LOCAL_USER_ID, 'Still orphaned');

    const user = await users.create({ username: 'fresh', password: 'correct horse battery' });

    // A brand-new id, so the old directory is neither claimed nor disturbed.
    expect(user.id).not.toBe(LOCAL_USER_ID);
    expect(await store.listIds(user.id)).toEqual([]);
    expect(await store.listIds(LOCAL_USER_ID)).toEqual([conversationId]);
    expect((await store.load(LOCAL_USER_ID, conversationId)).title).toBe('Still orphaned');
  });

  it('refuses to adopt a directory that already belongs to an account', async () => {
    await users.create({
      username: 'first',
      password: 'correct horse battery',
      id: LOCAL_USER_ID,
    });

    await expect(
      users.create({ username: 'second', password: 'correct horse battery', id: LOCAL_USER_ID })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('nothing is adopted automatically on login', async () => {
    await store.init(LOCAL_USER_ID);
    await store.create(LOCAL_USER_ID, 'Not yours');

    await createUser('ada');
    const client = await signInAs('ada');

    const listed = (await (await client.call('/api/conversations')).json()) as {
      conversations: unknown[];
    };
    expect(listed.conversations).toEqual([]);
  });
});
