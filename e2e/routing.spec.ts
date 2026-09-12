import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  composerField,
  expect,
  seedConversations,
  signIn,
  test,
} from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * The routes, as addresses rather than as screens.
 *
 * What is worth asserting about a router is the part a component test cannot
 * see: that a URL survives a reload, that Back undoes what Forward did, and
 * that the address bar and the screen never disagree. All of that needs a real
 * browser with real history, so it lives here.
 */

/** The path, without the origin, as a reader would read it out. */
function path(page: Page): string {
  return new URL(page.url()).pathname;
}

async function openFirstConversation(page: Page): Promise<void> {
  await page.locator('.conversation__open').first().click();
}

test('/ redirects to the new-chat draft', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await expect.poll(() => path(page)).toBe('/chat/new');
});

test('opening a conversation puts its id in the URL', async ({ app, page }) => {
  await seedConversations(app.dataDir, 2);
  await signIn(page, app.baseUrl);

  await openFirstConversation(page);
  await expect.poll(() => path(page)).toMatch(/^\/chat\/[0-9a-f-]{36}$/);
});

test('a conversation URL survives a reload', async ({ app, page }) => {
  await seedConversations(app.dataDir, 2);
  await signIn(page, app.baseUrl);

  /*
   * Taken from the row that is actually clicked rather than from the seeding
   * order. The list is grouped by date and ordered within a group by update
   * time, so "the first row" is not "the first conversation written".
   */
  const title = await page.locator('.conversation__open').first().innerText();
  const marker = `marker-for-${title.toLowerCase().replace(' ', '-')}`;
  await openFirstConversation(page);

  // Waited for, not read straight after the click: the header takes the new
  // title on the render after the navigation, and reading it earlier captures
  // the previous screen's.
  await expect(page.locator('.main__title')).toHaveText(title);
  const deepLink = path(page);

  await page.reload();

  // The same conversation, from the URL alone — no click, no client state.
  expect(path(page)).toBe(deepLink);
  await expect(page.locator('.main__title')).toHaveText(title);
  await expect(page.locator('.msg').first()).toContainText(marker);
});

test('back and forward move between conversations', async ({ app, page }) => {
  await seedConversations(app.dataDir, 2);
  await signIn(page, app.baseUrl);

  await page.locator('.conversation__open').nth(0).click();
  const first = path(page);
  await page.locator('.conversation__open').nth(1).click();
  const second = path(page);
  expect(second).not.toBe(first);

  await page.goBack();
  await expect.poll(() => path(page)).toBe(first);
  await page.goForward();
  await expect.poll(() => path(page)).toBe(second);
});

test('/chat/new creates nothing until a message is sent', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await expect.poll(() => path(page)).toBe('/chat/new');

  // Visiting the draft is not an act of creation.
  await page.reload();
  await expect(page.locator('.conversation__open')).toHaveCount(0);

  const composer = composerField(page);
  await expect(composer).toBeEnabled();
  await composer.fill('the first message');
  await composer.press('Enter');
  await app.provider.waitForStream();

  // Now it exists, and the URL is the conversation rather than the draft.
  await expect.poll(() => path(page)).toMatch(/^\/chat\/[0-9a-f-]{36}$/);
  await expect(page.locator('.conversation__open')).toHaveCount(1);

  /*
   * Replaced, not pushed: going back from a conversation that was just created
   * must not return to the empty draft that created it, which would show a
   * composer for a message that has already been sent.
   */
  await page.goBack();
  await expect.poll(() => path(page)).not.toBe('/chat/new');

  app.provider.finish();
});

test('/chats lists the conversations and links to them', async ({ app, page }) => {
  await seedConversations(app.dataDir, 3);
  await signIn(page, app.baseUrl);

  await page.goto(`${app.baseUrl}/chats`);
  await expect(page.locator('.page__list-item')).toHaveCount(3);

  await page.locator('.page__list-item').first().click();
  await expect.poll(() => path(page)).toMatch(/^\/chat\/[0-9a-f-]{36}$/);
});

test.describe('settings as a URL-synced overlay', () => {
  test('opens over the conversation and Back closes it', async ({ app, page }) => {
    await seedConversations(app.dataDir, 2);
    await signIn(page, app.baseUrl);

    // Read off the row, then waited for in the header: reading the header
    // straight after the click captures the screen being navigated away from.
    const title = await page.locator('.conversation__open').first().innerText();
    await openFirstConversation(page);
    await expect(page.locator('.main__title')).toHaveText(title);
    const conversation = path(page);

    await page.locator('.account').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    await expect.poll(() => path(page)).toBe('/settings');
    await expect(page.locator('.panel')).toBeVisible();

    /*
     * Still *that* conversation behind it, not merely some chat screen.
     *
     * The panel's own URL carries no conversation, so without the location it
     * was opened from being remembered, the screen underneath falls back to
     * the empty draft — the reader's conversation would visibly vanish the
     * moment they opened Settings, and reappear when they closed it.
     */
    await expect(page.locator('.transcript')).toBeVisible();
    await expect(page.locator('.main__title')).toHaveText(title);

    await page.goBack();
    await expect(page.locator('.panel')).toHaveCount(0);
    expect(path(page)).toBe(conversation);
  });

  test('a pasted /settings link opens the panel with a chat behind it', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    // No history state, so nothing to fall back on — it must still work.
    await page.goto(`${app.baseUrl}/settings`);

    await expect(page.locator('.panel')).toBeVisible();
    await expect(page.locator('.transcript')).toBeVisible();
  });
});

test('/admin is reachable by an admin', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await page.goto(`${app.baseUrl}/admin`);

  await expect(page.getByRole('dialog', { name: 'Administration' })).toBeVisible();
});

test('an unknown address gets the not-found screen, not the chat', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await page.goto(`${app.baseUrl}/no-such-page`);

  await expect(page.getByText('This page does not exist')).toBeVisible();
  await expect(page.locator('.transcript')).toHaveCount(0);
});

test('a protected URL sends you to /login and back again afterwards', async ({ app, page }) => {
  const markers = await seedConversations(app.dataDir, 1);

  // Signed out, straight to a conversation.
  await page.goto(`${app.baseUrl}/chats`);
  await expect.poll(() => path(page)).toBe('/login');

  await page.getByLabel('Username').fill(ADMIN_USERNAME);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Back to what was asked for, not to a generic landing page.
  await expect.poll(() => path(page)).toBe('/chats');
  await expect(page.locator('.page__list-item')).toHaveCount(1);
  expect(markers).toHaveLength(1);
});
