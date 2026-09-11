#!/usr/bin/env node
/**
 * Runs the API server and the Vite dev server together, so `npm run dev` is a
 * single command. Either child exiting tears down the other.
 *
 * The two processes must never share one `PORT`. An ambient `PORT` (set by a
 * shell, a container, or an editor's run configuration) is the *client* port;
 * the API gets `API_PORT` and Vite is pointed at it. Without this split both
 * children read the same variable and the API dies with EADDRINUSE.
 */
import { spawn } from 'node:child_process';

const clientPort = Number(process.env.PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3001);

if (clientPort === apiPort) {
  console.error(`Client and API cannot share port ${clientPort}. Set API_PORT to something else.`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exit(code);
}

function run(script, env) {
  const child = spawn('npm', ['run', script], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => shutdown(code ?? 0));
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`API  → http://localhost:${apiPort}`);
console.log(`Client → http://localhost:${clientPort} (proxying /api)\n`);

run('dev:server', { PORT: String(apiPort) });
run('dev:client', {
  PORT: String(clientPort),
  VITE_API_TARGET: `http://localhost:${apiPort}`,
});
