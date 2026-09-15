import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Each test starts its own server against a throwaway DATA_DIR (see
 * `e2e/fixtures.ts`), so there is no shared `webServer` here and no state
 * leaking between tests. The build must exist first — `test:e2e` builds.
 */
/**
 * A Chromium other than the one Playwright downloads.
 *
 * Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to run against a browser that is already
 * on the machine — a distribution package, or an image that ships one at a
 * different build number than this Playwright pins. Without it nothing changes:
 * Playwright uses its own download, which is what CI does.
 *
 * Unset is the default on purpose. A mismatched build can fail in ways that
 * look like the application's fault, so using one is a choice the person
 * running the tests makes deliberately.
 */
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

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
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
