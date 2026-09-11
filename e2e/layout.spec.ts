import { composerField, expect, seedMessages, signIn, startGeneration, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Layout and scroll behaviour in a real browser.
 *
 * These cannot be covered by component tests: jsdom has no layout engine, so
 * `scrollHeight`, sticky positioning, and overflow clipping are all either
 * stubbed or absent there. Every assertion below depends on real box geometry.
 */

/** The transcript's scroll container. */
function transcript(page: Page) {
  return page.getByTestId('transcript');
}

test.describe('transcript scrolling', () => {
  test('scrolls independently of the document in a long conversation', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(composerField(page)).toBeEnabled();

    await seedMessages(app.dataDir, 200);
    await page.reload();
    await page.locator('.conversation__open').first().click();

    await expect(page.locator('.msg--user')).toHaveCount(200);

    // The document itself must not be the scroller.
    const documentScrollable = await page.evaluate(
      () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
    );
    expect(documentScrollable).toBe(false);

    const box = transcript(page);
    const before = await box.evaluate((el) => el.scrollTop);
    await box.evaluate((el) => el.scrollTo({ top: 0 }));
    const after = await box.evaluate((el) => el.scrollTop);

    // It really did move, and it was the transcript that moved.
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // The composer stays put while the transcript scrolls beneath it.
    await expect(composerField(page)).toBeVisible();
  });

  test('streaming while scrolled up does not move the viewport', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await startGeneration(page, 'tell me something long');
    await app.provider.waitForStream();

    app.provider.send('first chunk of the answer. ');
    await expect(page.locator('.msg--assistant')).toContainText('first chunk');

    // Scroll away from the bottom, as a reader going back over the answer would.
    const box = transcript(page);
    await box.evaluate((el) => el.scrollTo({ top: 0 }));
    const parked = await box.evaluate((el) => el.scrollTop);

    for (let i = 0; i < 40; i += 1) app.provider.send(`more text chunk ${i}. `);
    await expect(page.locator('.msg--assistant')).toContainText('chunk 39');

    // Content grew underneath, but the viewport stayed where it was put.
    expect(await box.evaluate((el) => el.scrollTop)).toBe(parked);

    app.provider.finish();
  });

  test('jump to latest appears when unpinned and returns to the bottom', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(composerField(page)).toBeEnabled();

    // The transcript has to overflow before "scrolled away" means anything —
    // in a conversation that fits on screen the user is always at the bottom.
    await seedMessages(app.dataDir, 60);
    await page.reload();
    await page.locator('.conversation__open').first().click();
    await expect(page.locator('.msg--user')).toHaveCount(60);

    const box = transcript(page);
    const jump = page.getByRole('button', { name: 'Jump to latest' });

    const composer = composerField(page);
    await expect(composer).toBeEnabled();
    await composer.fill('tell me something long');
    await composer.press('Enter');
    await app.provider.waitForStream();

    app.provider.send('opening line. ');
    await expect(page.locator('.msg--assistant')).toContainText('opening line');

    // Pinned: nothing to offer.
    await expect(jump).toBeHidden();

    await box.evaluate((el) => el.scrollTo({ top: 0 }));
    for (let i = 0; i < 60; i += 1) app.provider.send(`padding line ${i}. `);

    await expect(jump).toBeVisible();
    await jump.click();

    // Back at the bottom, and the control retires itself.
    await expect(jump).toBeHidden();
    await expect
      .poll(async () => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThanOrEqual(48);

    app.provider.finish();
  });
});

test('the sidebar collapses and restores', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  const sidebar = page.getByRole('complementary');
  await expect(sidebar).toBeVisible();

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toBeHidden();

  // The transcript takes the reclaimed width rather than leaving a gap. The
  // grid column is animated, so this settles rather than being true at once.
  await expect
    .poll(async () => {
      const shell = await page.locator('.shell').evaluate((el) => el.clientWidth);
      const main = await page.locator('.main').evaluate((el) => el.clientWidth);
      return shell - main;
    })
    .toBe(0);

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebar).toBeVisible();
});

test.describe('overlays are not clipped', () => {
  test('the model menu escapes the composer', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(composerField(page)).toBeEnabled();

    await page.getByRole('button', { name: /Select a model|e2e-model/ }).click();

    const menu = page.getByRole('listbox', { name: 'Models' });
    await expect(menu).toBeVisible();

    // Portalled: its DOM parent is the body, not the composer.
    const parentIsBody = await menu.evaluate((el) => el.parentElement === document.body);
    expect(parentIsBody).toBe(true);

    // And it is fully on screen, not cut off by the composer's rounded box.
    const box = (await menu.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

    /*
     * The menu is anchored *above* its trigger, so it extends past the top of
     * the composer. The composer rounds and clips its own overflow, so a menu
     * rendered inside it would be trimmed at that edge; escaping it is the
     * whole point of the portal.
     */
    const composerBox = (await page.locator('.composer').boundingBox())!;
    expect(box.y).toBeLessThan(composerBox.y);
  });

  test('a confirmation dialog renders above the shell', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await page.getByRole('button', { name: 'New chat' }).click();

    await page.locator('.conversation').first().hover();
    await page
      .getByRole('button', { name: /^Delete / })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete this conversation?');

    // Escape dismisses without deleting.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.conversation')).toHaveCount(1);
  });
});
