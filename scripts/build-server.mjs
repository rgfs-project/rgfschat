#!/usr/bin/env node
/**
 * Bundles the server to `dist/server/index.js`.
 *
 * esbuild resolves the `@shared/*` tsconfig path at bundle time, so the emitted
 * JavaScript needs no runtime path mapping. Dependencies stay external and are
 * loaded from `node_modules` as usual.
 */
import { build } from 'esbuild';

/**
 * The server, and the operator CLIs beside it.
 *
 * `createUser` and `setPassword` are built as their own entries, not only run
 * through `tsx` in development: a production image (and anything running
 * `dist/` without the dev dependencies) has no `tsx` and no `.ts` source, so
 * the two operations an operator may have to perform without a session to
 * start from — creating the first admin, and resetting the password of an
 * account nobody can sign into any more — would otherwise be impossible in the
 * very environment they are needed in.
 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
};

await build({ ...shared, entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js' });
await build({
  ...shared,
  entryPoints: ['server/scripts/createUser.ts'],
  outfile: 'dist/server/scripts/createUser.js',
});
await build({
  ...shared,
  entryPoints: ['server/scripts/setPassword.ts'],
  outfile: 'dist/server/scripts/setPassword.js',
});
