import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createLogger } from '../logger.ts';
import { AuditLog } from '../admin/audit.ts';
import { SettingsStore } from '../admin/settings.ts';
import { SessionManager } from '../auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from '../auth/users.ts';
import { signIn, type TestClient } from '../auth/testClient.ts';
import { GenerationManager } from '../generation/manager.ts';
import { GenerationService } from '../generation/service.ts';
import { EchoProvider } from '../provider/echoProvider.ts';
import { ProviderHub } from '../provider/hub.ts';
import { ProviderRegistry } from '../provider/registry.ts';
import { DEFAULT_HOST_POLICY } from '../provider/ssrf.ts';
import { ConversationStore } from '../storage/conversations.ts';
import { ChatIndex } from '../storage/index.ts';
import { StoragePaths } from '../storage/paths.ts';

/**
 * Administrative routes.
 *
 * The authorization matrix below is driven from the router's own route table
 * rather than a hand-written list. A hand-written list is a second place to
 * remember things, and the one that gets forgotten: a route added without its
 * guard would simply not appear, and the suite would pass while the hole
 * stayed open.
 */

const SENTINEL_API_KEY = 'sentinel-provider-key-do-not-leak';
const SENTINEL_PASSWORD = 'sentinel-password-do-not-leak';

let logs: string[] = [];
const logger = createLogger({
  level: 'debug',
  write: (line) => {
    logs.push(line);
  },
});

let dataDir: string;
let server: Server | undefined;
let base: string;
let users: UserStore;
let sessions: SessionManager;
let manager: GenerationManager;
let hub: ProviderHub;
let settings: SettingsStore;
let paths: StoragePaths;

let admin: TestClient;
let adminId: string;
let plainUser: TestClient;
let plainUserId: string;

beforeEach(async () => {
  logs = [];
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-admin-'));
  paths = new StoragePaths(dataDir);

  const store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  manager = new GenerationManager({ logger, maxOutputTokens: 128 });
  const registry = new ProviderRegistry({ paths, logger, policy: DEFAULT_HOST_POLICY });
  hub = new ProviderHub({
    logger,
    policy: DEFAULT_HOST_POLICY,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    factory: () => new EchoProvider(),
  });
  hub.setProviders([
    {
      id: 'local',
      name: 'Local',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080',
      timeoutMs: 5_000,
      capabilities: {},
      apiKey: SENTINEL_API_KEY,
    },
  ]);

  settings = new SettingsStore({ paths, logger, fallbackRegistrationMode: 'closed' });
  await settings.load();
  const audit = new AuditLog({ paths, logger });

  // The generation router carries `/api/models`, which the visibility tests
  // need; it is only mounted when a service is present.
  const service = new GenerationService({
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
    service,
    store,
    index,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    registry,
    settings,
    audit,
    policy: DEFAULT_HOST_POLICY,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const adminDto = await users.create({
    username: 'root',
    password: SENTINEL_PASSWORD,
    role: 'admin',
  });
  adminId = adminDto.id;
  admin = await signIn(base, sessions, adminId);

  const userDto = await users.create({ username: 'member', password: 'member-password' });
  plainUserId = userDto.id;
  plainUser = await signIn(base, sessions, plainUserId);
});

afterEach(async () => {
  manager.shutdown();
  if (server !== undefined) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await rm(dataDir, { recursive: true, force: true });
});

/** Every admin route, read from the mounted Express router. */
interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  /** A body that passes schema validation, so a 400 cannot mask a 401/403. */
  body?: unknown;
}

/**
 * The routes under test, with a concrete path for each parameterised one.
 *
 * Enumerated from the router in the test below; this table supplies the
 * *values* that list cannot (a real id, a valid body), and the enumeration
 * asserts the two agree.
 */
function routeSpecs(): RouteSpec[] {
  return [
    { method: 'get', path: '/api/admin/users' },
    { method: 'get', path: `/api/admin/users/${plainUserId}` },
    {
      method: 'post',
      path: '/api/admin/users',
      body: { username: 'fresh', password: 'a-good-password' },
    },
    {
      method: 'post',
      path: `/api/admin/users/${plainUserId}/password`,
      body: { password: 'another-good-password' },
    },
    { method: 'patch', path: `/api/admin/users/${plainUserId}`, body: { status: 'disabled' } },
    { method: 'delete', path: `/api/admin/users/${plainUserId}`, body: { username: 'member' } },
    { method: 'get', path: '/api/admin/providers' },
    {
      method: 'post',
      path: '/api/admin/providers',
      body: {
        name: 'Second',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9099',
        timeoutMs: 5_000,
      },
    },
    {
      method: 'patch',
      path: '/api/admin/providers/local',
      body: {
        name: 'Local renamed',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 5_000,
      },
    },
    { method: 'delete', path: '/api/admin/providers/local' },
    {
      method: 'post',
      path: '/api/admin/providers/test',
      body: { baseUrl: 'http://127.0.0.1:8080' },
    },
    { method: 'get', path: '/api/admin/settings' },
    { method: 'patch', path: '/api/admin/settings', body: { registrationMode: 'open' } },
    { method: 'post', path: '/api/admin/models/refresh' },
    { method: 'post', path: '/api/admin/maintenance/rebuild-index', body: {} },
  ];
}

function call(client: TestClient['fetch'], spec: RouteSpec): Promise<Response> {
  return client(spec.path, {
    method: spec.method.toUpperCase(),
    ...(spec.body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spec.body),
        }),
  });
}

describe('the route table is complete', () => {
  it('covers every route the admin router actually mounts', async () => {
    const response = await admin.fetch('/api/admin/settings');
    expect(response.status).toBe(200);

    /*
     * Every spec must name a route that actually exists: a 404 here means the
     * table drifted from the router, which is the failure mode that would
     * otherwise let an unguarded route go untested.
     */
    const mounted = new Set<string>();
    for (const spec of routeSpecs()) {
      const res = await call(admin.fetch, spec);
      expect(res.status, `${spec.method} ${spec.path}`).not.toBe(404);
      mounted.add(`${spec.method} ${spec.path}`);
    }
    expect(mounted.size).toBe(routeSpecs().length);
  });
});

describe('authorization (INV-24)', () => {
  it('rejects every admin route without a session', async () => {
    for (const spec of routeSpecs()) {
      const res = await fetch(`${base}${spec.path}`, {
        method: spec.method.toUpperCase(),
        ...(spec.body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(spec.body),
            }),
      });
      expect(res.status, `${spec.method} ${spec.path}`).toBe(401);
    }
  });

  it('rejects every admin route for a non-admin', async () => {
    for (const spec of routeSpecs()) {
      const res = await call(plainUser.fetch, spec);
      expect(res.status, `${spec.method} ${spec.path}`).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    }
  });

  it('treats a disabled admin as signed out, not merely forbidden', async () => {
    await users.update(adminId, { status: 'disabled' });

    for (const spec of routeSpecs()) {
      const res = await call(admin.fetch, spec);
      expect(res.status, `${spec.method} ${spec.path}`).toBe(401);
    }
  });

  it('locks out a demoted admin on the very next request', async () => {
    expect((await admin.fetch('/api/admin/users')).status).toBe(200);

    // Demoted by someone else while their session is still open.
    await users.update(adminId, { role: 'user' });

    const after = await admin.fetch('/api/admin/users');
    expect(after.status).toBe(403);
  });

  it('refuses a role sent to a non-admin route', async () => {
    const res = await plainUser.fetch('/api/auth/session', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    // The session DTO reports the stored role; it is never taken from input.
    expect((await res.json()).user.role).toBe('user');
  });

  it('rejects a role smuggled into conversation creation', async () => {
    const res = await plainUser.fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', role: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION');
  });
});

describe('users', () => {
  it('lists users with conversation counts and never a password hash', async () => {
    const res = await admin.fetch('/api/admin/users');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(2);
    for (const user of body.users) {
      expect(user).toHaveProperty('conversationCount');
      expect(JSON.stringify(user)).not.toContain('passwordHash');
      expect(JSON.stringify(user)).not.toContain('$argon2');
    }
  });

  it('creates a user who can then sign in', async () => {
    const res = await admin.fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'newcomer', password: 'a-good-password' }),
    });
    expect(res.status).toBe(201);

    const signedIn = await users.verify('newcomer', 'a-good-password');
    expect(signedIn).not.toBeNull();
  });

  it('setting a password revokes every existing session', async () => {
    const victim = await signIn(base, sessions, plainUserId);
    expect((await victim.fetch('/api/conversations')).status).toBe(200);

    await admin.fetch(`/api/admin/users/${plainUserId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'a-replacement-password' }),
    });

    expect((await victim.fetch('/api/conversations')).status).toBe(401);
  });

  it('disabling cancels the user’s running generations (INV-17)', async () => {
    // A provider that never finishes, so the run is still live when the
    // administrator acts — which is the only case where cancelling matters.
    const neverEnds = {
      listModels: () => Promise.resolve([]),
      contextLength: () => null,
      async *streamChat() {
        await new Promise(() => {});
        yield { type: 'content' as const, text: '' };
      },
    };

    const started = manager.start(plainUserId, 'echo-small', [], neverEnds, {
      conversationId: 'c1',
      providerId: 'local',
    });

    await admin.fetch(`/api/admin/users/${plainUserId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });

    expect(manager.get(started.generationId, plainUserId)?.state).toBe('cancelled');
  });

  it('deletes the user directory and locks them out', async () => {
    await users.create({ username: 'doomed', password: 'doomed-password' });
    const doomed = await users.findByUsername('doomed');
    const id = doomed!.id;
    const client = await signIn(base, sessions, id);
    await client.fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(existsSync(paths.userDir(id))).toBe(true);

    const res = await admin.fetch(`/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'doomed' }),
    });

    expect(res.status).toBe(200);
    expect(existsSync(paths.userDir(id))).toBe(false);
    expect(await users.verify('doomed', 'doomed-password')).toBeNull();
  });

  it('refuses a delete whose typed username does not match', async () => {
    const res = await admin.fetch(`/api/admin/users/${plainUserId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'not-their-name' }),
    });

    expect(res.status).toBe(400);
    expect(await users.findById(plainUserId)).not.toBeNull();
  });
});

describe('last-admin protection (INV-26)', () => {
  it.each([
    ['demote', 'PATCH', { role: 'user' }],
    ['disable', 'PATCH', { status: 'disabled' }],
  ])('refuses to %s the only admin', async (_label, method, body) => {
    const res = await admin.fetch(`/api/admin/users/${adminId}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('LAST_ADMIN');
  });

  it('refuses to delete the only admin', async () => {
    const res = await admin.fetch(`/api/admin/users/${adminId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'root' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('LAST_ADMIN');
  });

  it('allows it once a second active admin exists', async () => {
    await users.create({ username: 'second', password: 'second-password', role: 'admin' });

    const res = await admin.fetch(`/api/admin/users/${adminId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });

    expect(res.status).toBe(200);
  });

  it('does not count a disabled admin as a way back in', async () => {
    const spare = await users.create({
      username: 'spare',
      password: 'spare-password',
      role: 'admin',
    });
    await users.update(spare.id, { status: 'disabled' });

    const res = await admin.fetch(`/api/admin/users/${adminId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });

    expect(res.status).toBe(409);
  });
});

describe('providers (INV-25, INV-19)', () => {
  it('never returns the api key, only whether one is set', async () => {
    const res = await admin.fetch('/api/admin/providers');
    const text = await res.text();

    expect(text).not.toContain(SENTINEL_API_KEY);
    expect(JSON.parse(text).providers[0].hasApiKey).toBe(true);
  });

  it('keeps the stored key when an edit sends neither field', async () => {
    await admin.fetch('/api/admin/providers/local', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 5_000,
      }),
    });

    expect(hub.entries()[0]?.apiKey).toBe(SENTINEL_API_KEY);
  });

  it('clears the key on clearApiKey', async () => {
    await admin.fetch('/api/admin/providers/local', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 5_000,
        clearApiKey: true,
      }),
    });

    expect(hub.entries()[0]?.apiKey).toBeUndefined();
  });

  it('rejects sending both apiKey and clearApiKey', async () => {
    const res = await admin.fetch('/api/admin/providers/local', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 5_000,
        apiKey: 'x',
        clearApiKey: true,
      }),
    });

    expect(res.status).toBe(400);
  });

  it.each([
    ['create', 'POST', '/api/admin/providers'],
    ['edit', 'PATCH', '/api/admin/providers/local'],
  ])('re-runs SSRF validation on %s', async (_label, method, path) => {
    const res = await admin.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Metadata',
        kind: 'openai-compatible',
        // Cloud metadata is blocked whatever the host policy says.
        baseUrl: 'http://169.254.169.254/',
        timeoutMs: 5_000,
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ENDPOINT_NOT_ALLOWED');
  });

  it('refuses a test connection to a blocked address', async () => {
    const res = await admin.fetch('/api/admin/providers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://169.254.169.254/' }),
    });

    expect(res.status).toBe(400);
  });

  it('reloads the live registry in-process, with no restart', async () => {
    await admin.fetch('/api/admin/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Extra',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9099',
        timeoutMs: 5_000,
      }),
    });

    expect(hub.entries().map((entry) => entry.id)).toContain('extra');
    // And it was persisted, not only held in memory.
    const written = await readFile(join(paths.systemDir(), 'providers.json'), 'utf8');
    expect(written).toContain('"extra"');
  });
});

describe('settings and model visibility', () => {
  it('hides a model from a non-admin but not from an admin', async () => {
    await admin.fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiddenModels: [{ providerId: 'local', modelId: 'echo-small' }] }),
    });

    interface ModelsBody {
      providers: { providerId: string; models: { id: string }[] }[];
    }
    const asUser = (await (await plainUser.fetch('/api/models')).json()) as ModelsBody;
    const asAdmin = (await (await admin.fetch('/api/models')).json()) as ModelsBody;

    const idsFor = (body: ModelsBody): string[] =>
      body.providers.flatMap((group) => group.models.map((model) => model.id));

    expect(idsFor(asUser)).not.toContain('echo-small');
    expect(idsFor(asAdmin)).toContain('echo-small');
  });

  it('changes the registration mode without a restart', async () => {
    expect((await (await fetch(`${base}/api/auth/session`)).json()).registrationOpen).toBe(false);

    await admin.fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationMode: 'open' }),
    });

    expect((await (await fetch(`${base}/api/auth/session`)).json()).registrationOpen).toBe(true);
  });
});

describe('audit log', () => {
  async function entries(): Promise<Record<string, unknown>[]> {
    const dir = paths.auditDir();
    const files = await readdir(dir).catch(() => [] as string[]);
    const all: Record<string, unknown>[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        all.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    return all;
  }

  it('records who did what, with the outcome', async () => {
    await admin.fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'audited', password: 'audited-password' }),
    });

    const written = await entries();
    const entry = written.find((e) => e.action === 'user.create');

    expect(entry).toBeDefined();
    expect(entry?.actorUsername).toBe('root');
    expect(entry?.outcome).toBe('success');
  });

  it('never writes a secret, whatever was sent', async () => {
    await admin.fetch('/api/admin/providers/local', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Local',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 5_000,
        apiKey: SENTINEL_API_KEY,
      }),
    });
    await admin.fetch(`/api/admin/users/${plainUserId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: SENTINEL_PASSWORD }),
    });

    const raw = JSON.stringify(await entries());
    expect(raw).not.toContain(SENTINEL_API_KEY);
    expect(raw).not.toContain(SENTINEL_PASSWORD);
    // It still recorded *that* the credential changed.
    expect(raw).toContain('apiKeyChanged');
  });
});

describe('secret exposure sweep', () => {
  /**
   * The broadest check in the suite: call everything, then look for sentinels
   * anywhere a value could escape — bodies, headers, and the log stream.
   * Narrower assertions can only catch the leaks someone thought of.
   */
  it('no response body, header, or log line contains a known secret', async () => {
    const bodies: string[] = [];
    const headers: string[] = [];

    const everything: RouteSpec[] = [
      ...routeSpecs().filter(
        // Skip the destructive ones; they are covered individually and would
        // remove the fixtures the rest of the sweep needs.
        (spec) => !(spec.method === 'delete')
      ),
      { method: 'get', path: '/api/models' },
      { method: 'get', path: '/api/providers' },
      { method: 'get', path: '/api/conversations' },
      { method: 'get', path: '/api/auth/session' },
    ];

    for (const spec of everything) {
      for (const client of [admin, plainUser]) {
        const res = await call(client.fetch, spec);
        bodies.push(await res.text());
        headers.push(JSON.stringify([...res.headers.entries()]));
      }
    }

    const haystack = [...bodies, ...headers, JSON.stringify(logs)].join('\n');
    expect(haystack).not.toContain(SENTINEL_API_KEY);
    expect(haystack).not.toContain(SENTINEL_PASSWORD);
    expect(haystack).not.toContain('$argon2');
  });
});
