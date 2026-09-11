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
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

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

  console.log(`\n[2/3] Starting server on ${baseUrl} (DATA_DIR=${dataDir})…`);
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

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

    // 3. Clean shutdown.
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
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nverify: ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('\nverify: all checks passed.\n');
}

await main();
