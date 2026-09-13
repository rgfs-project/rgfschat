import AxeBuilder from '@axe-core/playwright';
import { composerField, expect, seedConversations, signIn, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Automated accessibility scans on every screen, in both themes.
 *
 * axe cannot find every WCAG issue — keyboard order, focus, and screen-reader
 * announcements still need a human — but it catches the mechanical ones
 * (contrast, labels, roles, landmarks) reliably and on every screen at once,
 * which is where regressions hide.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    localStorage.setItem('workspace.theme', t);
    document.documentElement.dataset.theme = t;
  }, theme);
}

async function scan(page: Page): Promise<{ id: string; nodes: number; impact: string | null }[]> {
  const result = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return result.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.length,
    impact: v.impact ?? null,
  }));
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility — ${theme}`, () => {
    test('sign-in screen has no violations', async ({ app, page }) => {
      await page.goto(app.baseUrl);
      await setTheme(page, theme);
      await page.reload();
      await expect(page.getByLabel('Username')).toBeVisible();

      const violations = await scan(page);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test('chat screen with a conversation has no violations', async ({ app, page }) => {
      await seedConversations(app.dataDir, 2);
      await signIn(page, app.baseUrl);
      await setTheme(page, theme);
      await page.reload();
      await expect(composerField(page)).toBeVisible();

      const violations = await scan(page);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test('settings panel has no violations', async ({ app, page }) => {
      await signIn(page, app.baseUrl);
      await setTheme(page, theme);
      await page.goto(`${app.baseUrl}/settings`);
      await expect(page.locator('.panel')).toBeVisible();

      const violations = await scan(page);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });

    test('admin panel has no violations', async ({ app, page }) => {
      await signIn(page, app.baseUrl);
      await setTheme(page, theme);
      await page.goto(`${app.baseUrl}/admin`);
      await expect(page.locator('.panel')).toBeVisible();

      const violations = await scan(page);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  });
}
