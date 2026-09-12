import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from './app.ts';
import { createLogger } from './logger.ts';
import { AuditLog } from './admin/audit.ts';
import { SettingsStore } from './admin/settings.ts';
import { SessionManager } from './auth/sessions.ts';
import { ARGON2_TEST_OPTIONS, UserStore } from './auth/users.ts';
import { signIn, type TestClient } from './auth/testClient.ts';
import { AttachmentStore } from './attachments/store.ts';
import { GenerationManager } from './generation/manager.ts';
import { GenerationService } from './generation/service.ts';
import { EchoProvider } from './provider/echoProvider.ts';
import { ProviderHub } from './provider/hub.ts';
import { ProviderRegistry } from './provider/registry.ts';
import { DEFAULT_HOST_POLICY } from './provider/ssrf.ts';
import { ConversationStore } from './storage/conversations.ts';
import { ChatIndex } from './storage/index.ts';
import { MemoryStore } from './storage/memories.ts';
import { PreferencesStore } from './storage/preferences.ts';
import { StoragePaths } from './storage/paths.ts';

/**
 * The whole-application security properties, enumerated from the real router.
 *
 * Hand-written lists of routes are the thing these tests exist to avoid: a
 * route added without a guard would simply not appear on such a list, and the
 * suite would pass while the hole stayed open. Everything here walks
 * `app.router` instead, so a new route is covered the moment it is mounted and
 * a route that cannot be covered has to be named and justified below.
 */

/** Values planted so a leak is unambiguous when one is found. */
const SENTINEL_PASSWORD = 'sentinel-password-do-not-leak';
const SENTINEL_API_KEY = 'sentinel-provider-key-do-not-leak';

let logs: string[] = [];
const logger = createLogger({
  level: 'debug',
  write: (line) => {
    logs.push(line);
  },
});

let dataDir: string;
let app: Express;
let server: Server | undefined;
let base: string;
let admin: TestClient;
let manager: GenerationManager;
let service: GenerationService;

interface Route {
  method: string;
  path: string;
}

/** Every route the application actually mounts, read from the router. */
function mountedRoutes(): Route[] {
  const found: Route[] = [];

  const walk = (stack: unknown[]): void => {
    for (const entry of stack) {
      const layer = entry as {
        route?: { path?: string; methods?: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
      };

      if (layer.route?.path !== undefined) {
        for (const method of Object.keys(layer.route.methods ?? {})) {
          // Express registers HEAD alongside GET; it is the same handler.
          if (method === 'head') continue;
          found.push({ method: method.toUpperCase(), path: `/api${layer.route.path}` });
        }
        continue;
      }
      if (layer.handle?.stack !== undefined) walk(layer.handle.stack);
    }
  };

  walk((app as unknown as { router: { stack: unknown[] } }).router.stack);
  return found;
}

/** Fills route parameters with values that are well-formed but do not exist. */
function concrete(path: string): string {
  return path
    .replace(/:id\b/g, '00000000-0000-4000-8000-000000000000')
    .replace(/:conversationId\b/g, '00000000-0000-4000-8000-000000000000')
    .replace(/:name\b/g, 'a-memory')
    .replace(/:[A-Za-z]+/g, 'placeholder');
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that legitimately have no CSRF token to present.
 *
 * Both are the routes that *establish* a session, so there is no session for a
 * synchroniser token to be bound to. They are protected by the same-origin
 * check instead (contracts §5), which is asserted separately below.
 */
const PRE_SESSION = new Set(['POST /api/auth/register', 'POST /api/auth/login']);

beforeEach(async () => {
  logs = [];
  dataDir = await mkdtemp(join(tmpdir(), 'security-'));
  const paths = new StoragePaths(dataDir);

  const store = new ConversationStore({ paths, logger });
  const index = new ChatIndex({ store, logger });
  const preferences = new PreferencesStore(paths, logger);
  const memories = new MemoryStore(paths, logger);
  const attachments = new AttachmentStore(paths, {
    maxBytes: 1024,
    maxTotalBytesPerUser: 8192,
    pendingTtlMs: 60_000,
    maxImagePixels: 50_000_000,
  });

  const users = new UserStore({ paths, logger, argon2Options: ARGON2_TEST_OPTIONS });
  const sessions = new SessionManager({
    paths,
    logger,
    absoluteTtlMs: 3_600_000,
    idleTtlMs: 3_600_000,
  });

  manager = new GenerationManager({ logger, maxOutputTokens: 128 });
  const hub = new ProviderHub({
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

  const registry = new ProviderRegistry({ paths, logger, policy: DEFAULT_HOST_POLICY });
  const settings = new SettingsStore({ paths, logger, fallbackRegistrationMode: 'closed' });
  await settings.load();
  const audit = new AuditLog({ paths, logger });

  service = new GenerationService({
    store,
    index,
    manager,
    hub,
    logger,
    defaultContextTokens: 8_192,
    maxOutputTokens: 128,
    attachments,
  });

  app = createApp({
    logger,
    hub,
    manager,
    service,
    store,
    index,
    preferences,
    memories,
    users,
    sessions,
    authConfig: { registrationMode: 'closed', absoluteTtlMs: 3_600_000, idleTtlMs: 3_600_000 },
    registry,
    settings,
    audit,
    attachments,
    policy: DEFAULT_HOST_POLICY,
    isProduction: true,
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const account = await users.create({
    username: 'root',
    password: SENTINEL_PASSWORD,
    role: 'admin',
  });
  admin = await signIn(base, sessions, account.id);
});

afterEach(async () => {
  await service.allSettled();
  manager.shutdown();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe('the enumeration itself', () => {
  it('finds the application’s routes, so the tests below mean something', () => {
    const routes = mountedRoutes();
    // A number rather than a list: the assertion is that enumeration works at
    // all, and a list here would be the hand-written table this avoids.
    expect(routes.length).toBeGreaterThan(25);
    expect(routes.some((route) => route.path === '/api/health')).toBe(true);
  });
});

describe('CSRF (INV-16)', () => {
  it('rejects every state-changing route that is sent without a token', async () => {
    const unprotected: string[] = [];

    for (const route of mountedRoutes()) {
      if (!STATE_CHANGING.has(route.method)) continue;
      const name = `${route.method} ${route.path}`;
      if (PRE_SESSION.has(name)) continue;

      // A valid session cookie and no CSRF token: exactly what a cross-site
      // form submission has, since the browser sends the cookie for it.
      const response = await fetch(`${base}${concrete(route.path)}`, {
        method: route.method,
        headers: { Cookie: `workspace_session=${encodeURIComponent(admin.token)}` },
      });

      if (response.status !== 403) {
        unprotected.push(`${name} -> ${response.status}`);
        continue;
      }
      const body = (await response.json()) as { error?: { code?: string } };
      if (body.error?.code !== 'CSRF_INVALID') unprotected.push(`${name} -> ${body.error?.code}`);
    }

    expect(unprotected, unprotected.join('\n')).toEqual([]);
  });

  it('protects the two pre-session routes by origin instead', async () => {
    for (const name of PRE_SESSION) {
      const [method, path] = name.split(' ') as [string, string];
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ username: 'someone', password: 'a-good-password' }),
      });

      expect(response.status, name).toBe(403);
      expect((await response.json()).error.code, name).toBe('CSRF_INVALID');
    }
  });
});

describe('validation (INV-02)', () => {
  it('rejects an unknown field on every route that takes a body', async () => {
    const accepted: string[] = [];

    for (const route of mountedRoutes()) {
      if (!STATE_CHANGING.has(route.method)) continue;

      const response = await admin.fetch(concrete(route.path), {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        // A field no schema declares, alongside nothing else. A route with a
        // strict schema rejects it; one without would ignore it.
        body: JSON.stringify({ __unexpected__: 'x' }),
      });

      // 400 VALIDATION is the pass. 404/409/415 mean the request never reached
      // a schema, which is also fine — what must not happen is 2xx.
      if (response.status < 300) accepted.push(`${route.method} ${route.path}`);
    }

    expect(accepted, accepted.join('\n')).toEqual([]);
  });
});

describe('error leakage (INV-01, INV-03)', () => {
  it('never returns a stack trace, a path, or a secret, however malformed the input', async () => {
    const payloads = [
      '{"a":',
      '[]',
      'null',
      '"just a string"',
      JSON.stringify({ conversationId: '../../etc/passwd' }),
      JSON.stringify({ id: { $ne: null } }),
      JSON.stringify({ username: 'x'.repeat(10_000) }),
      JSON.stringify({ __proto__: { admin: true } }),
    ];

    const leaks: string[] = [];

    for (const route of mountedRoutes()) {
      if (!STATE_CHANGING.has(route.method)) continue;

      for (const payload of payloads) {
        const response = await admin.fetch(concrete(route.path), {
          method: route.method,
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });

        const text = await response.text();
        const where = `${route.method} ${route.path}`;

        if (/ {4}at |\.ts:\d+|node_modules/.test(text)) leaks.push(`${where}: stack trace`);
        if (text.includes(dataDir)) leaks.push(`${where}: data directory path`);
        if (text.includes(SENTINEL_API_KEY)) leaks.push(`${where}: provider key`);
        if (text.includes(SENTINEL_PASSWORD)) leaks.push(`${where}: password`);
        if (/passwordHash|argon2/i.test(text)) leaks.push(`${where}: password hash`);
      }
    }

    expect(leaks, leaks.join('\n')).toEqual([]);
  }, 60_000);
});

describe('log leakage', () => {
  it('writes no secret to the log, at any level', async () => {
    // Exercise the paths most likely to log something: a failed sign-in, a
    // rejected body, and a provider listing that holds a configured key.
    await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ username: 'root', password: SENTINEL_PASSWORD }),
    });
    await admin.fetch('/api/admin/providers');
    await admin.fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"nope":1}',
    });

    const written = logs.join('\n');
    expect(written).not.toContain(SENTINEL_PASSWORD);
    expect(written).not.toContain(SENTINEL_API_KEY);
    expect(written).not.toContain(admin.token);
    expect(written).not.toContain(admin.csrfToken);
  });
});

describe('security headers', () => {
  it('are present on the API as well as on the shell', async () => {
    const response = await admin.fetch('/api/conversations');

    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('are present on an error response too', async () => {
    // Authenticated, so this reaches the 404 rather than the auth gate — an
    // anonymous request gets 401, which is correct but is a different path.
    const response = await admin.fetch('/api/nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
