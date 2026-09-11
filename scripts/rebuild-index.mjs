#!/usr/bin/env node
/**
 * Rebuilds the derived conversation index from canonical Markdown.
 *
 * The index is a cache, never a source of truth (INV-11): deleting it loses
 * nothing and this script restores it. Useful after hand-editing files under
 * `data/<user>/chats/`. The admin route arrives in Phase 9.
 *
 *   npm run index:rebuild
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'npx',
  ['tsx', '--env-file-if-exists=.env', 'server/scripts/rebuildIndex.ts'],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
