#!/usr/bin/env node
/**
 * Bundles the server to `dist/server/index.js`.
 *
 * esbuild resolves the `@shared/*` tsconfig path at bundle time, so the emitted
 * JavaScript needs no runtime path mapping. Dependencies stay external and are
 * loaded from `node_modules` as usual.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});
