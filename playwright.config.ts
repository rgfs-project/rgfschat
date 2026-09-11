import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Each test starts its own server against a throwaway DATA_DIR (see
 * `e2e/fixtures.ts`), so there is no shared `webServer` here and no state
 * leaking between tests. The build must exist first — `test:e2e` builds.
 */
export default defineConfig({
  testDir: './e2e',
  // Deterministic ordering matters more than speed: these tests drive a shared
  // provider stream per worker and assert on exact text.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  reporter: process.env['CI'] === 'true' ? 'line' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
