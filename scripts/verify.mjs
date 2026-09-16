#!/usr/bin/env node
/**
 * End-to-end verification against the *real* built server.
 *
 * Builds, starts `dist/server/index.js` on a free port with a throwaway
 * DATA_DIR, then asserts:
 *   1. GET /api/health           → 200 and the exact DTO shape
 *   2. GET /api/does-not-exist   → canonical 404 error body
 *   3. SIGTERM                   → clean exit within the grace period
 *
 * Unlike the unit tests, nothing here is mocked: this is the artifact that ships.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const PROVIDER_KEY = 'verify-provider-key-do-not-log';
const LOCAL_USER_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const ADMIN_PASSWORD = 'verify-admin-passphrase';
const SESSION_COOKIE = 'workspace_session';

/** Everything below the auth gate needs a session cookie and a CSRF token. */
let auth = null;

function authHeaders(extra = {}) {
  if (auth === null) return extra;
  return { Cookie: `${SESSION_COOKIE}=${auth.token}`, 'X-CSRF-Token': auth.csrf, ...extra };
}

/** Authenticated fetch: the only way the checks below reach the API. */
function afetch(url, init = {}) {
  return fetch(url, { ...init, headers: authHeaders(init.headers ?? {}) });
}

function cookieValue(setCookie, name) {
  for (const part of (setCookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Creates an account through the real CLI, with the password on stdin. */
function createAccount(dataDir, username, extraArgs = []) {
  const result = spawnSync(
    'npx',
    ['tsx', 'server/scripts/createUser.ts', '--username', username, ...extraArgs],
    {
      input: `${ADMIN_PASSWORD}\n`,
      env: { ...process.env, DATA_DIR: dataDir, LOCAL_USER_ID, LOG_LEVEL: 'error' },
      encoding: 'utf8',
    }
  );
  return result;
}

async function signIn(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ username, password: ADMIN_PASSWORD }),
  });
  if (!response.ok) return null;

  const body = await response.json();
  return {
    token: cookieValue(response.headers.get('set-cookie'), SESSION_COOKIE),
    csrf: body.csrfToken,
    userId: body.user.id,
  };
}

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** Asks the OS for a free port, then releases it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A fresh instance must never be claimable by whoever reaches the port first.
 *
 * Registration opens by itself while no account exists, so that a brand new
 * deployment can be claimed without a CLI. `ADMIN_PASSWORD` is the operator
 * saying they would rather claim it themselves — and for that to mean anything,
 * the account has to exist before the listener does. When the bootstrap was
 * merely *started* at boot rather than awaited, the port answered during the
 * argon2 hash and a caller racing it was handed the first admin account: a 201,
 * on an instance the operator thought they had already claimed.
 *
 * So this races the port exactly as such a caller would, from a cold container
 * with its own empty DATA_DIR, and asserts the very first answer is a refusal.
 */
async function checkFirstAdminRace() {
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'verify-race-'));
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
      ADMIN_PASSWORD,
      ADMIN_USERNAME: 'bootadmin',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let answer = null;

    // No delay and no backoff: the whole point is to be the first request the
    // listener ever accepts.
    while (answer === null && Date.now() < deadline && child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'racer', password: 'racer-chosen-passphrase' }),
        });
        // A 404 is the SPA fallback answering before the API is mounted; keep going.
        if (res.status !== 404) answer = res.status;
      } catch {
        // Not listening yet.
      }
    }

    check(
      'ADMIN_PASSWORD: registration is already closed on the first request the port answers',
      answer !== null && answer >= 400,
      answer === null ? 'the port never answered' : `registration returned ${answer}`
    );
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not become healthy within ${STARTUP_TIMEOUT_MS}ms`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * A deterministic stand-in for llama.cpp, reproducing the wire shapes recorded
 * in docs/provider-notes.md — including the two that break naive parsers: a
 * `null` content delta on the first chunk, and an empty `choices` array on the
 * last. Kept self-contained so `verify` needs no test infrastructure.
 */
async function startMockProvider({ chunkDelayMs = 0 } = {}) {
  const reasoning = ['weighing ', 'the options'];
  const content = ['Hello', ', ', 'world'];

  const server = createHttpServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      if (req.headers.authorization !== `Bearer ${PROVIDER_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API Key', code: 401 } }));
        return;
      }

      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'Mock Model',
                object: 'model',
                owned_by: 'llamacpp',
                // Mirrors the real payload's leaky fields; the server must drop them.
                status: {
                  value: 'loaded',
                  args: ['/app/llama-server', '--api-key-file', '/run/api-key'],
                  preset: '[Mock]\napi-key-file = /run/api-key\n',
                },
                architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              },
            ],
          })
        );
        return;
      }

      if (!req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found', code: 404 } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const wrap = (choices, extra = {}) => ({
        choices,
        created: 1,
        id: 'chatcmpl-verify',
        model: 'Mock Model',
        object: 'chat.completion.chunk',
        ...extra,
      });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      try {
        send(
          wrap([{ index: 0, finish_reason: null, delta: { role: 'assistant', content: null } }])
        );
        for (const text of reasoning) {
          await wait(chunkDelayMs);
          send(wrap([{ index: 0, finish_reason: null, delta: { reasoning_content: text } }]));
        }
        for (const text of content) {
          await wait(chunkDelayMs);
          send(wrap([{ index: 0, finish_reason: null, delta: { content: text } }]));
        }
        send(wrap([{ index: 0, finish_reason: 'stop', delta: {} }]));
        send(wrap([], { usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 } }));
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
        // Client hung up.
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** Reads an SSE stream until `stopAfter` events, then hangs up mid-flight. */
async function readStreamUntil(url, stopAfter) {
  const response = await afetch(url);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const ids = [];
  const events = [];
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let id = null;
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (data === '') continue;
      events.push(JSON.parse(data));
      if (id !== null) ids.push(id);

      if (events.length >= stopAfter) {
        await reader.cancel();
        return { ids, events };
      }
    }
  }
  return { ids, events };
}

/** Reads an SSE stream to its end, returning parsed events and accumulated text. */
async function readStream(url) {
  const response = await afetch(url);
  const events = [];
  const ids = [];
  let content = '';
  let reasoning = '';
  let buffer = '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let id = null;
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (data === '') continue;

      const event = JSON.parse(data);
      events.push(event);
      if (id !== null) ids.push(id);
      if (event.type === 'content') content += event.delta;
      if (event.type === 'reasoning') reasoning += event.delta;
    }
  }

  return { events, ids, content, reasoning, headers: response.headers };
}

async function main() {
  console.log('\n[1/3] Building…');
  const built = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('Build failed.');
    process.exit(1);
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'workspace-verify-'));

  // A deterministic stand-in for llama.cpp, speaking the format recorded in
  // docs/provider-notes.md. `verify` must never depend on a real GPU box.
  const provider = await startMockProvider({ chunkDelayMs: 15 });

  /*
   * The provider is configured rather than bootstrapped.
   *
   * The server used to write a `providers.json` from `LLAMA_BASE_URL` when the
   * file was absent, and this script relied on it. It no longer does — an
   * instance that invents a provider pointing at a machine that may not exist
   * is worse than one that lists none — so the file the server would have
   * written is written here, which is also closer to what an operator does.
   */
  await mkdir(join(dataDir, '_system'), { recursive: true });
  await writeFile(
    join(dataDir, '_system', 'providers.json'),
    JSON.stringify(
      {
        version: 1,
        providers: [
          {
            id: 'local',
            name: 'Local llama.cpp',
            kind: 'openai-compatible',
            baseUrl: provider.url,
            apiKey: PROVIDER_KEY,
            timeoutMs: 120_000,
            capabilities: {},
          },
        ],
      },
      null,
      2
    )
  );

  console.log(`\n[2/3] Starting server on ${baseUrl} (DATA_DIR=${dataDir})…`);
  console.log(`      mock provider at ${provider.url}`);

  const startServer = () =>
    spawn(process.execPath, ['dist/server/index.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        NODE_ENV: 'production',
        LOCAL_USER_ID,
        LLAMA_BASE_URL: provider.url,
        LLAMA_API_KEY: PROVIDER_KEY,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

  let child = startServer();

  /** Stops the server and starts a fresh one on the same DATA_DIR. */
  const restart = async () => {
    child.kill('SIGTERM');
    await waitForExit(child);
    child = startServer();
    await waitForHealth(baseUrl, child);
  };

  try {
    await waitForHealth(baseUrl, child);

    console.log('\n[3/3] Checking contracts…');

    // 1. Health.
    const health = await fetch(`${baseUrl}/api/health`);
    const healthBody = await health.json();
    check('health responds 200', health.status === 200, `got ${health.status}`);
    check(
      'health body is exactly { status, version }',
      healthBody.status === 'ok' &&
        typeof healthBody.version === 'string' &&
        healthBody.version.length > 0 &&
        Object.keys(healthBody).sort().join(',') === 'status,version',
      `got ${JSON.stringify(healthBody)}`
    );

    // 2. Authentication (Phase 4), before anything protected is reachable.
    console.log('\n   auth:');
    // Its own cold instance, because what is being checked is the boot itself.
    await checkFirstAdminRace();
    const anonymous = await fetch(`${baseUrl}/api/conversations`);
    check(
      'protected routes reject an anonymous caller',
      anonymous.status === 401,
      `got ${anonymous.status}`
    );

    const created = createAccount(dataDir, 'verifyadmin', ['--admin', '--adopt-local-data']);
    check(
      'first admin is created by the CLI with the password on stdin',
      created.status === 0,
      created.stderr
    );

    const rejectedArgv = createAccount(dataDir, 'argvuser', ['--password', 'secret']);
    check(
      'the CLI refuses a password passed in argv',
      rejectedArgv.status !== 0 && /not supported/.test(rejectedArgv.stderr ?? ''),
      rejectedArgv.stderr
    );

    auth = await signIn(baseUrl, 'verifyadmin');
    check(
      'sign-in returns a session and a CSRF token',
      auth?.token !== null && auth?.csrf !== undefined
    );
    check(
      'the adopted account owns the Phase 3 data directory',
      auth?.userId === LOCAL_USER_ID,
      `got ${auth?.userId}`
    );

    const noCsrf = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${auth.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    check(
      'INV-16: a state-changing request without a CSRF token is rejected',
      noCsrf.status === 403,
      `got ${noCsrf.status}`
    );

    // 3. Unknown route → canonical 404 (for an authenticated caller; an
    //    anonymous one is stopped by the auth gate first).
    const missing = await afetch(`${baseUrl}/api/does-not-exist`);
    const missingBody = await missing.json();
    check('unknown route responds 404', missing.status === 404, `got ${missing.status}`);
    check(
      'unknown route uses the canonical error contract',
      missingBody?.error?.code === 'NOT_FOUND' && typeof missingBody?.error?.message === 'string',
      `got ${JSON.stringify(missingBody)}`
    );
    check(
      'error body leaks no internals',
      !JSON.stringify(missingBody).includes('/') || missingBody.error.details === undefined,
      `got ${JSON.stringify(missingBody)}`
    );

    // 4. A real generation, start to finish, over real HTTP and SSE.
    const models = await (await afetch(`${baseUrl}/api/models`)).json();
    const group = models.providers?.[0];
    check(
      'models are listed, grouped by provider',
      Array.isArray(models.providers) && (group?.models?.length ?? 0) > 0,
      JSON.stringify(models).slice(0, 200)
    );
    check(
      'INV-04/25: no credential, endpoint, or upstream payload in the model list',
      !JSON.stringify(models).includes(PROVIDER_KEY) &&
        !JSON.stringify(models).includes('api-key-file') &&
        !JSON.stringify(models).includes('apiKey') &&
        !JSON.stringify(models).includes('baseUrl') &&
        !JSON.stringify(models).includes('.gguf'),
      JSON.stringify(models).slice(0, 200)
    );

    const providers = await (await afetch(`${baseUrl}/api/providers`)).json();
    check(
      'providers are listed with a status',
      Array.isArray(providers.providers) &&
        providers.providers.length > 0 &&
        typeof providers.providers[0].status === 'string',
      JSON.stringify(providers).slice(0, 200)
    );
    check(
      'INV-25: the provider listing carries no secret or endpoint',
      !JSON.stringify(providers).includes(PROVIDER_KEY) &&
        !JSON.stringify(providers).includes('apiKey') &&
        !JSON.stringify(providers).includes('baseUrl'),
      JSON.stringify(providers).slice(0, 200)
    );

    // From Phase 3 a generation belongs to a persisted conversation, and the
    // client sends only the new message.
    const firstConversation = await (
      await afetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).json();

    const started = await afetch(`${baseUrl}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: firstConversation.id,
        providerId: group.providerId,
        model: group.models[0].id,
        content: 'hello',
      }),
    });
    const accepted = await started.json();
    check('generation accepted with 202', started.status === 202, `got ${started.status}`);
    check(
      'all ids are minted',
      typeof accepted.generationId === 'string' &&
        typeof accepted.userMessageId === 'string' &&
        typeof accepted.assistantMessageId === 'string',
      JSON.stringify(accepted)
    );

    const stream = await readStream(`${baseUrl}/api/generations/${accepted.generationId}/stream`);
    check(
      'SSE uses the contract headers',
      stream.headers.get('content-type')?.includes('text/event-stream') === true &&
        stream.headers.get('x-accel-buffering') === 'no' &&
        stream.headers.get('content-encoding') === null,
      `content-type=${stream.headers.get('content-type')}`
    );
    check(
      'SSE opens with a snapshot',
      stream.events[0]?.type === 'snapshot',
      stream.events[0]?.type
    );
    check(
      'every SSE event carries an increasing id',
      stream.ids.length > 1 && stream.ids.every((id, i) => i === 0 || id > stream.ids[i - 1]),
      JSON.stringify(stream.ids)
    );
    check(
      'stream reaches a terminal done event',
      stream.events.at(-1)?.type === 'done' && stream.events.at(-1)?.state === 'completed',
      JSON.stringify(stream.events.at(-1))
    );
    check(
      'content and reasoning arrive separately',
      stream.content === 'Hello, world' && stream.reasoning.length > 0,
      `content=${JSON.stringify(stream.content)} reasoning=${JSON.stringify(stream.reasoning)}`
    );

    const snapshot = await (
      await afetch(`${baseUrl}/api/generations/${accepted.generationId}`)
    ).json();
    check(
      're-observable after completion',
      snapshot.state === 'completed' && snapshot.content === 'Hello, world',
      JSON.stringify(snapshot)
    );

    const unknownModel = await afetch(`${baseUrl}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: firstConversation.id,
        providerId: group.providerId,
        model: 'nope',
        content: 'x',
      }),
    });
    const unknownBody = await unknownModel.json();
    check(
      'unknown model is rejected with MODEL_NOT_FOUND',
      unknownModel.status === 400 && unknownBody.error?.code === 'MODEL_NOT_FOUND',
      JSON.stringify(unknownBody)
    );

    const unknownProvider = await afetch(`${baseUrl}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: firstConversation.id,
        providerId: 'no-such-provider',
        model: group.models[0].id,
        content: 'x',
      }),
    });
    const unknownProviderBody = await unknownProvider.json();
    check(
      'INV-18: an unknown provider is rejected',
      unknownProvider.status === 400 && unknownProviderBody.error?.code === 'PROVIDER_NOT_FOUND',
      JSON.stringify(unknownProviderBody)
    );

    // 5. Persistence (Phase 3), end to end against the built server.
    console.log('\n   persistence:');
    const chatsDir = join(dataDir, LOCAL_USER_ID, 'chats');
    const indexFile = join(dataDir, LOCAL_USER_ID, 'index', 'chats.json');

    const api = {
      create: async () =>
        (
          await afetch(`${baseUrl}/api/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).json(),
      list: async () => (await (await afetch(`${baseUrl}/api/conversations`)).json()).conversations,
      get: async (id) => {
        const res = await afetch(`${baseUrl}/api/conversations/${id}`);
        return { status: res.status, body: await res.json() };
      },
      remove: async (id) =>
        (await afetch(`${baseUrl}/api/conversations/${id}`, { method: 'DELETE' })).status,
      send: async (id, content) => {
        const res = await afetch(`${baseUrl}/api/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: id,
            providerId: group.providerId,
            model: 'Mock Model',
            content,
          }),
        });
        return { status: res.status, body: await res.json() };
      },
    };

    // create → send → generate
    const conversation = await api.create();
    check(
      'conversation created',
      typeof conversation.id === 'string',
      JSON.stringify(conversation)
    );

    const sent = await api.send(conversation.id, 'remember this');
    check('generation accepted for a conversation', sent.status === 202, `got ${sent.status}`);
    check(
      'all three ids are minted',
      ['assistantMessageId', 'generationId', 'userMessageId'].every(
        (k) => typeof sent.body[k] === 'string'
      ),
      JSON.stringify(sent.body)
    );

    const markdownPath = join(chatsDir, `${conversation.id}.md`);
    check(
      'INV-08: the user message is on disk immediately after 202',
      (await readFile(markdownPath, 'utf8')).includes('remember this')
    );

    await readStream(`${baseUrl}/api/generations/${sent.body.generationId}/stream`);
    // The assistant block is appended after the terminal state; poll briefly.
    let markdown = '';
    for (let i = 0; i < 100; i += 1) {
      markdown = await readFile(markdownPath, 'utf8');
      if (markdown.includes('cc:assistant')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    check(
      'INV-07: exactly one assistant block is persisted',
      (markdown.match(/cc:assistant/g) || []).length === 1,
      markdown.slice(0, 200)
    );
    check(
      'the completed state is written as status=complete',
      markdown.includes('status=complete '),
      markdown.slice(0, 300)
    );

    // restart with the same DATA_DIR → persistence
    await restart();
    const afterRestart = await api.get(conversation.id);
    check(
      'conversation survives a restart',
      afterRestart.status === 200 && afterRestart.body.messages.length === 2,
      JSON.stringify(afterRestart.body).slice(0, 200)
    );

    // delete the index → restart → rebuild
    await unlink(indexFile);
    await restart();
    const rebuilt = await api.list();
    check(
      'INV-11: the index rebuilds after being deleted',
      rebuilt.some((e) => e.id === conversation.id) && rebuilt.every((e) => !e.malformed),
      JSON.stringify(rebuilt)
    );

    // hand-edit the Markdown → reflected
    const edited = (await readFile(markdownPath, 'utf8')).replace(
      /title: "[^"]*"/,
      'title: "Edited by hand"'
    );
    await writeFile(markdownPath, edited);
    const afterEdit = await api.get(conversation.id);
    check(
      'a hand-edit to Markdown is reflected',
      afterEdit.body.title === 'Edited by hand',
      afterEdit.body.title
    );

    // corrupt one file → isolated
    const other = await api.create();
    const corruptPath = join(chatsDir, `${other.id}.md`);
    await writeFile(corruptPath, '---\nformatVersion: 9\n---\n');
    await unlink(indexFile);
    await restart();

    const corruptRead = await api.get(other.id);
    check(
      'a corrupt conversation returns CONVERSATION_MALFORMED',
      corruptRead.status === 422 && corruptRead.body.error?.code === 'CONVERSATION_MALFORMED',
      JSON.stringify(corruptRead.body)
    );
    check(
      'a corrupt conversation is still listed as malformed',
      (await api.list()).find((e) => e.id === other.id)?.malformed === true
    );
    check(
      'the healthy conversation still works alongside it',
      (await api.get(conversation.id)).status === 200
    );
    check(
      'the corrupt file was never rewritten',
      (await readFile(corruptPath, 'utf8')) === '---\nformatVersion: 9\n---\n'
    );

    // delete → gone
    check('a corrupt conversation can be deleted', (await api.remove(other.id)) === 204);
    check('deleting removes it from the index', !(await api.list()).some((e) => e.id === other.id));
    check(
      'deleting removes the Markdown file',
      !(await readdir(chatsDir)).includes(`${other.id}.md`)
    );

    // 6. Reconnection (Phase 6): a dropped stream resumed with Last-Event-ID
    //    must not produce a second canonical assistant write.
    console.log('\n   reconnection:');
    const reconnectConversation = await (
      await afetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).json();

    const reconnectRun = await (
      await afetch(`${baseUrl}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: reconnectConversation.id,
          providerId: group.providerId,
          model: 'Mock Model',
          content: 'reconnect please',
        }),
      })
    ).json();

    // Read part of the stream, then hang up mid-flight.
    const partial = await readStreamUntil(
      `${baseUrl}/api/generations/${reconnectRun.generationId}/stream`,
      2
    );
    check(
      'a partial read yields events with ids',
      partial.ids.length >= 1,
      JSON.stringify(partial.ids)
    );

    // Reconnect from where we left off.
    const resumed = await readStream(
      `${baseUrl}/api/generations/${reconnectRun.generationId}/stream?lastEventId=${partial.ids.at(-1)}`
    );
    const replayedIds = resumed.ids.filter((id) => id <= partial.ids.at(-1));
    check(
      'INV-20: the resumed stream replays only what was missed',
      replayedIds.length === 0 || resumed.events[0]?.type === 'resync',
      JSON.stringify({ replayedIds, first: resumed.events[0]?.type })
    );
    check(
      'the resumed stream reaches a terminal event',
      resumed.events.at(-1)?.type === 'done' ||
        resumed.events.some((e) => e.type === 'resync' || e.type === 'snapshot'),
      JSON.stringify(resumed.events.at(-1))
    );

    // Give the canonical write time to land, then count assistant blocks.
    const reconnectPath = join(chatsDir, `${reconnectConversation.id}.md`);
    let reconnectMarkdown = '';
    for (let i = 0; i < 100; i += 1) {
      reconnectMarkdown = await readFile(reconnectPath, 'utf8');
      if (reconnectMarkdown.includes('cc:assistant')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    check(
      'INV-07: reconnecting produced exactly one canonical assistant write',
      (reconnectMarkdown.match(/cc:assistant/g) || []).length === 1,
      reconnectMarkdown.slice(0, 200)
    );

    // 6b. Multi-user isolation and logout.
    console.log('\n   isolation:');
    const ownConversation = await (
      await afetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Admin only' }),
      })
    ).json();

    const second = createAccount(dataDir, 'seconduser');
    check('a second account is created', second.status === 0, second.stderr);

    const adminAuth = auth;
    auth = await signIn(baseUrl, 'seconduser');
    check('the second user can sign in', auth?.token !== null);

    const otherList = await (await afetch(`${baseUrl}/api/conversations`)).json();
    check(
      "INV-15: a second user sees none of the first user's conversations",
      Array.isArray(otherList.conversations) && otherList.conversations.length === 0,
      JSON.stringify(otherList)
    );
    const cross = await afetch(`${baseUrl}/api/conversations/${ownConversation.id}`);
    check(
      "INV-15: another user's conversation is 404, never 403",
      cross.status === 404,
      `got ${cross.status}`
    );

    const loggedOut = await afetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
    check('logout succeeds', loggedOut.status === 204, `got ${loggedOut.status}`);
    const afterLogout = await afetch(`${baseUrl}/api/conversations`);
    check(
      'a destroyed session no longer authenticates',
      afterLogout.status === 401,
      `got ${afterLogout.status}`
    );

    auth = adminAuth;
    check(
      'the first user still has their conversation',
      (await afetch(`${baseUrl}/api/conversations/${ownConversation.id}`)).status === 200
    );

    // 7. Clean shutdown.
    child.kill('SIGTERM');
    const exited = await Promise.race([
      waitForExit(child),
      new Promise((r) =>
        setTimeout(() => r({ code: null, signal: 'TIMEOUT' }), SHUTDOWN_TIMEOUT_MS)
      ),
    ]);
    check(
      'server exits cleanly on SIGTERM',
      exited.code === 0,
      `exit code ${exited.code}, signal ${exited.signal}`
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await provider.close();
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nverify: ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('\nverify: all checks passed.\n');
}

await main();
