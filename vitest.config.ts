import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = {
  '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
};

/*
 * Two projects, because the suites need different globals.
 *
 * Server and format tests run under `node` — several of them touch the real
 * filesystem and `node:crypto`, and a jsdom global scope would only get in the
 * way. Component tests need a DOM, so they get their own project rather than
 * forcing jsdom on everything (it is markedly slower to spin up, and it would
 * mask a server module accidentally reaching for `window`).
 *
 * The split is by extension: `.test.ts` is node, `.test.tsx` is the DOM.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: ['{server,shared,client}/**/*.test.ts'],
          restoreMocks: true,
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'dom',
          globals: true,
          environment: 'jsdom',
          include: ['client/**/*.test.tsx'],
          setupFiles: ['./client/test-setup.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
});
