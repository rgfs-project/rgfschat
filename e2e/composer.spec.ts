import { composerField, expect, signIn, startGeneration, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * The composer, measured by a real browser.
 *
 * Its height comes from the text that is actually in it, which is a question
 * only a browser can answer: a row count assumes a line height the font may
 * not have, and says nothing about a pasted paragraph or a window that has
 * just been narrowed.
 */

const heightOf = async (page: Page): Promise<number> => {
  const box = await composerField(page).boundingBox();
  return box?.height ?? 0;
};

/** The composer's outer box, which is what must never leave the screen. */
async function composerBox(page: Page): Promise<{ y: number; height: number }> {
  const box = await page.locator('.composer').boundingBox();
  return { y: box?.y ?? 0, height: box?.height ?? 0 };
}

test('rests small and grows with the text', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  const composer = composerField(page);
  const resting = await heightOf(page);

  await composer.fill('one line');
  expect(await heightOf(page)).toBe(resting);

  await composer.fill('one\ntwo\nthree');
  const taller = await heightOf(page);
  expect(taller).toBeGreaterThan(resting);

  await composer.fill('one\ntwo\nthree\nfour\nfive\nsix');
  expect(await heightOf(page)).toBeGreaterThan(taller);
});

test('stops growing and scrolls inside itself', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  const composer = composerField(page);
  await composer.fill('line\n'.repeat(40));

  const height = await heightOf(page);
  expect(height).toBeLessThanOrEqual(210);

  const scrolls = await composer.evaluate(
    (node: HTMLTextAreaElement) => node.scrollHeight > node.clientHeight
  );
  expect(scrolls).toBe(true);
});

test('shrinks again when the text goes', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  const composer = composerField(page);
  const resting = await heightOf(page);

  await composer.fill('one\ntwo\nthree\nfour');
  expect(await heightOf(page)).toBeGreaterThan(resting);

  await composer.fill('');
  expect(await heightOf(page)).toBe(resting);
});

test('shrinks after a message is sent', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  const composer = composerField(page);
  const resting = await heightOf(page);

  await composer.fill('a question\nasked over\nseveral lines');
  expect(await heightOf(page)).toBeGreaterThan(resting);

  await composer.press('Enter');
  await app.provider.waitForStream();

  expect(await heightOf(page)).toBe(resting);
  app.provider.finish();
});

test('keeps Enter sending and Shift+Enter inserting a newline', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  const composer = composerField(page);
  await composer.fill('first line');
  await composer.press('Shift+Enter');
  await composer.type('second line');

  expect(await composer.inputValue()).toBe('first line\nsecond line');
  expect(await heightOf(page)).toBeGreaterThan(30);

  await composer.press('Enter');
  await app.provider.waitForStream();
  await expect(page.locator('.msg--user')).toContainText('second line');
  app.provider.finish();
});

test('keeps the controls aligned and the send button a real target', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await composerField(page).fill('one\ntwo\nthree\nfour\nfive');

  const send = await page.getByRole('button', { name: 'Send message' }).boundingBox();
  const attach = await page.getByRole('button', { name: 'Attach files' }).boundingBox();

  // Same row: their centres line up vertically.
  const sendCentre = (send?.y ?? 0) + (send?.height ?? 0) / 2;
  const attachCentre = (attach?.y ?? 0) + (attach?.height ?? 0) / 2;
  expect(Math.abs(sendCentre - attachCentre)).toBeLessThan(2);
});

/*
 * The composer changing height changes the transcript's height, which is the
 * one thing that can move a question the reader is following without anyone
 * scrolling.
 */
test('growing does not move the anchored question', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  await startGeneration(page, 'a first question');
  await app.provider.waitForStream();
  app.provider.send('An answer, at some length.\n\n'.repeat(20));
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const composer = composerField(page);
  await composer.fill('the question to follow');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.send('The reply begins.\n\n');
  await page.waitForTimeout(150);

  const before = (await page.locator('.msg--user').last().boundingBox())?.y ?? 0;

  // A long draft typed while the reply streams: the composer grows under it.
  await composer.fill('a draft\ntyped\nwhile\nreading\nthe reply');
  await page.waitForTimeout(150);

  const after = (await page.locator('.msg--user').last().boundingBox())?.y ?? 0;
  expect(after).toBeLessThanOrEqual(before + 2);

  app.provider.finish();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the field is a comfortable target at rest', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    const box = await composerField(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    const send = await page.getByRole('button', { name: 'Send message' }).boundingBox();
    expect(send?.height ?? 0).toBeGreaterThanOrEqual(36);
  });

  test('stays on screen as the viewport shortens, as a keyboard makes it', async ({
    app,
    page,
  }) => {
    await signIn(page, app.baseUrl);
    const before = await composerBox(page);
    expect(before.y).toBeGreaterThan(0);

    // What `interactive-widget=resizes-content` does when the keyboard opens.
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForTimeout(150);

    const after = await composerBox(page);
    expect(after.y + after.height).toBeLessThanOrEqual(420);
    expect(after.y).toBeGreaterThan(0);
  });

  test('grows within the shortened viewport rather than off it', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await page.setViewportSize({ width: 390, height: 420 });

    await composerField(page).fill('a\nlong\ndraft\ntyped\non\na\nphone\nwith\nthe\nkeyboard\nup');
    await page.waitForTimeout(150);

    const box = await composerBox(page);
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThanOrEqual(420);
  });
});
