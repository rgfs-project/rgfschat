import { expect, signIn, startGeneration, test } from './fixtures.ts';

/**
 * Browser-level proof of the reconnection guarantees.
 *
 * These are the cases that unit tests cannot settle: a real EventSource, a real
 * reload, a real network interruption. The provider stream is advanced by the
 * test, so each assertion happens at a known point rather than after a guess.
 */

test('reloading mid-generation resumes the stream', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await startGeneration(page, 'tell me about bridges');
  await app.provider.waitForStream();

  app.provider.send('The first ');
  await expect(page.locator('.msg--assistant')).toContainText('The first');

  // Reload while the generation is still running.
  await page.reload();

  // The conversation and its in-flight run are rediscovered from the server.
  await expect(page.locator('.msg--assistant')).toContainText('The first', { timeout: 15_000 });

  // And it is genuinely still live: new text arrives after the reload.
  app.provider.send('bridges were ');
  await expect(page.locator('.msg--assistant')).toContainText('bridges were');

  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  // One provider request: the reload observed the existing run rather than
  // starting a second one.
  expect(app.provider.requests).toBe(1);
});

test('a dropped connection reconnects with no duplicated or lost text', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await startGeneration(page, 'count for me');
  await app.provider.waitForStream();

  app.provider.send('one ');
  await expect(page.locator('.msg--assistant')).toContainText('one');

  // Cut the browser off mid-stream, then let it back on. EventSource reconnects
  // by itself, sending Last-Event-ID.
  await page.context().setOffline(true);
  app.provider.send('two ');
  app.provider.send('three ');
  await page.waitForTimeout(300);
  await page.context().setOffline(false);

  // Everything sent while offline is replayed, exactly once.
  const assistant = page.locator('.msg--assistant');
  await expect(assistant).toContainText('two', { timeout: 15_000 });
  await expect(assistant).toContainText('three');

  app.provider.send('four ');
  await expect(assistant).toContainText('four');

  const text = (await assistant.innerText()).replace(/\s+/g, ' ');
  // No word appears twice: the server replayed rather than resent from scratch,
  // and the client did not deduplicate to cover for it.
  for (const word of ['one', 'two', 'three', 'four']) {
    expect(text.split(word).length - 1, `${word} in "${text}"`).toBe(1);
  }

  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('cancelling from the UI stops the run and keeps the partial reply', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await startGeneration(page, 'write something long');
  await app.provider.waitForStream();

  app.provider.send('partial answer ');
  await expect(page.locator('.msg--assistant')).toContainText('partial answer');

  await page.getByRole('button', { name: 'Stop' }).click();

  // The composer comes back, and the partial text is kept rather than discarded.
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.msg--assistant')).toContainText('partial answer');

  // Reloading proves it was persisted, not merely left on screen.
  await page.reload();
  await page.getByRole('button', { name: 'New conversation' }).waitFor();
  await page.locator('.conversation__open').first().click();
  await expect(page.locator('.msg--assistant')).toContainText('partial answer');
});
