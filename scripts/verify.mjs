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
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const PROVIDER_KEY = 'verify-provider-key-do-not-log';
const LOCAL_USER_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

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

/** Reads an SSE stream to its end, returning parsed events and accumulated text. */
async function readStream(url) {
  const response = await fetch(url);
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

    // 2. Unknown route → canonical 404.
    const missing = await fetch(`${baseUrl}/api/does-not-exist`);
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

    // 3. A real generation, start to finish, over real HTTP and SSE.
    const models = await (await fetch(`${baseUrl}/api/models`)).json();
    check(
      'models are listed',
      Array.isArray(models.models) && models.models.length > 0,
      JSON.stringify(models)
    );
    check(
      'INV-04: no credential or upstream payload in the model list',
      !JSON.stringify(models).includes(PROVIDER_KEY) &&
        !JSON.stringify(models).includes('api-key-file') &&
        !JSON.stringify(models).includes('.gguf'),
      JSON.stringify(models).slice(0, 200)
    );

    // From Phase 3 a generation belongs to a persisted conversation, and the
    // client sends only the new message.
    const firstConversation = await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).json();

    const started = await fetch(`${baseUrl}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: firstConversation.id,
        model: models.models[0].id,
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
      await fetch(`${baseUrl}/api/generations/${accepted.generationId}`)
    ).json();
    check(
      're-observable after completion',
      snapshot.state === 'completed' && snapshot.content === 'Hello, world',
      JSON.stringify(snapshot)
    );

    const unknownModel = await fetch(`${baseUrl}/api/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: firstConversation.id,
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

    // 4. Persistence (Phase 3), end to end against the built server.
    console.log('\n   persistence:');
    const chatsDir = join(dataDir, LOCAL_USER_ID, 'chats');
    const indexFile = join(dataDir, LOCAL_USER_ID, 'index', 'chats.json');

    const api = {
      create: async () =>
        (
          await fetch(`${baseUrl}/api/conversations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).json(),
      list: async () => (await (await fetch(`${baseUrl}/api/conversations`)).json()).conversations,
      get: async (id) => {
        const res = await fetch(`${baseUrl}/api/conversations/${id}`);
        return { status: res.status, body: await res.json() };
      },
      remove: async (id) =>
        (await fetch(`${baseUrl}/api/conversations/${id}`, { method: 'DELETE' })).status,
      send: async (id, content) => {
        const res = await fetch(`${baseUrl}/api/generations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: id, model: 'Mock Model', content }),
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

    // 5. Clean shutdown.
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
