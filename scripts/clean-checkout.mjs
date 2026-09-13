#!/usr/bin/env node
/**
 * Proves the app works from nothing but a built tree.
 *
 * No test harness, no fixtures, no dev dependencies at runtime: a temporary
 * DATA_DIR, the admin CLI as an operator would run it, the built server on a
 * free port, and a full conversation driven over the real HTTP boundary
 * against a deterministic mock provider. It is the containerised deployment's
 * bare-metal twin — if this fails, the Docker image would too.
 *
 * Run after `npm run build`. Exits non-zero on the first broken step.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';

const log = (m) => process.stdout.write(`  ${m}\n`);
const fail = (m) => {
  process.stderr.write(`CLEAN-CHECKOUT FAILED: ${m}\n`);
  process.exit(1);
};

function freePort() {
  return new Promise((res, rej) => {
    const s = netServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/** A deterministic mock llama.cpp: one model, a fixed streamed reply. */
function mockProvider() {
  const open = new Set();
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ data: [{ id: 'mock', architecture: { input_modalities: ['text'] } }] })
        );
        return;
      }
      if (req.url?.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const t of ['Hello', ', ', 'world']) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`
          );
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404).end('{}');
    });
    res.on('close', () => open.delete(res));
  });
  return srv;
}

const ADMIN = 'cleanadmin';
const PASSWORD = 'clean-checkout-password';

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'clean-checkout-'));
  const provider = mockProvider();
  const providerPort = await freePort();
  await new Promise((r) => provider.listen(providerPort, '127.0.0.1', r));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    LOG_LEVEL: 'error',
    PORT: String(port),
    DATA_DIR: dataDir,
    LLAMA_BASE_URL: `http://127.0.0.1:${providerPort}`,
  };

  let server;
  const cleanup = () => {
    try {
      server?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    try {
      provider.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    // 1. Create the first admin exactly as an operator would — built CLI, plain node.
    log('creating the first admin via the built CLI');
    const create = spawnSync(
      'node',
      ['dist/server/scripts/createUser.js', '--username', ADMIN, '--admin'],
      { input: `${PASSWORD}\n`, env, encoding: 'utf8' }
    );
    if (create.status !== 0) fail(`createUser exited ${create.status}: ${create.stderr}`);

    // 2. Boot the built server.
    log('starting the built server');
    server = spawn('node', ['dist/server/index.js'], { env, stdio: 'ignore' });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (server.exitCode !== null) fail(`server exited early: ${server.exitCode}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) fail('server never became healthy');
      await new Promise((r) => setTimeout(r, 200));
    }

    // 3. Sign in.
    log('signing in');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ username: ADMIN, password: PASSWORD }),
    });
    if (!login.ok) fail(`login ${login.status}`);
    const { csrfToken } = await login.json();
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const auth = { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' };

    // 4. Create a conversation and send a message; drive a full generation.
    log('creating a conversation and sending a message');
    const conv = await (
      await fetch(`${base}/api/conversations`, { method: 'POST', headers: auth, body: '{}' })
    ).json();
    const send = await fetch(`${base}/api/generations`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        conversationId: conv.id,
        providerId: 'local',
        model: 'mock',
        content: 'hi',
      }),
    });
    if (send.status !== 202) fail(`generation start ${send.status}`);

    // 5. Confirm the reply landed in canonical storage.
    log('waiting for the reply to persist');
    let ok = false;
    for (let i = 0; i < 100; i += 1) {
      const detail = await (
        await fetch(`${base}/api/conversations/${conv.id}`, { headers: auth })
      ).json();
      const assistant = (detail.messages ?? []).find(
        (m) => m.type === 'assistant' && m.body.includes('Hello')
      );
      if (assistant) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ok) fail('the assistant reply never reached storage');

    log('OK — clean checkout serves a full conversation end to end');
    cleanup();
    process.exit(0);
  } catch (err) {
    cleanup();
    fail(String(err));
  }
}

void main();
