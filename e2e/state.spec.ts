import { composerField, expect, seedConversations, signIn, test } from './fixtures.ts';

/**
 * Client state and loading, in a real browser.
 *
 * The component tests drive a stand-in server in jsdom, which is where the
 * ordering properties are asserted precisely. These cover the two things that
 * stand-in cannot reproduce: a genuinely slow network with real connection
 * timing, and switching driven by real clicks against a real server.
 */

test('the cold load fetches session, conversations and models concurrently', async ({
  app,
  page,
}) => {
  const started: { url: string; at: number }[] = [];
  const origin = Date.now();

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/')) started.push({ url, at: Date.now() - origin });
  });

  // A slow session: if anything waited on it, the others would start late.
  await page.route('**/api/auth/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  await signIn(page, app.baseUrl);

  const at = (fragment: string): number | undefined =>
    started.find((r) => r.url.includes(fragment) && !r.url.includes('session'))?.at;

  const sessionStart = started.find((r) => r.url.includes('/api/auth/session'))?.at;
  const conversations = at('/api/conversations');
  const models = at('/api/models');

  expect(sessionStart).toBeDefined();
  expect(conversations).toBeDefined();
  expect(models).toBeDefined();

  /*
   * The evidence: both started well inside the session's 1200ms delay. Serially
   * they could not have begun until after it resolved.
   */
  expect(conversations! - sessionStart!).toBeLessThan(1000);
  expect(models! - sessionStart!).toBeLessThan(1000);
});

test('a slow cold load shows no signed-in or signed-out flash', async ({ app, page }) => {
  await page.route('**/api/auth/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  await page.goto(app.baseUrl);

  // Mid-flight: neither the login form nor the application chrome.
  await expect(page.getByText('Loading…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New chat' })).toBeHidden();
  await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeHidden();

  // And it resolves to exactly one of them.
  await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible({ timeout: 15_000 });
});

test('rapid conversation switching lands on the last one chosen', async ({ app, page }) => {
  const markers = await seedConversations(app.dataDir, 3);
  await signIn(page, app.baseUrl);

  const rows = page.locator('.conversation__open');
  await expect(rows).toHaveCount(3);

  // Clicked faster than the reads can possibly answer.
  await rows.nth(0).click();
  await rows.nth(1).click();
  await rows.nth(2).click();

  const last = await rows.nth(2).innerText();
  await expect(page.locator('.main__title')).toHaveText(last);

  // The transcript shows that conversation's content and no other's.
  const transcript = page.getByTestId('transcript');
  await expect(transcript).toContainText(/marker-for-conversation-\d/);

  const shown = (await transcript.innerText()).match(/marker-for-conversation-\d/g) ?? [];
  expect(new Set(shown).size).toBe(1);
  expect(markers).toContain(shown[0]);
});

test('rapid model switching keeps the last choice', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(composerField(page)).toBeEnabled();

  const trigger = page.getByRole('button', { name: /e2e-model|Select a model/ });

  // Open and choose repeatedly; the selector must settle, not oscillate.
  for (let i = 0; i < 3; i += 1) {
    await trigger.click();
    await page.getByRole('option', { name: /e2e-model/ }).click();
  }

  await expect(trigger).toHaveText(/e2e-model/);
  await expect(composerField(page)).toHaveAttribute('placeholder', 'Message e2e-model');
});
