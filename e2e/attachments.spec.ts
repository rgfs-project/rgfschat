import { composerField, expect, signIn, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Attachments, end to end.
 *
 * The part that needs a real browser is the part where a file becomes a
 * request: a file input, a paste with an image on the clipboard, and an
 * `<img>` that has to still resolve after a reload. None of that can be
 * asserted from a unit test.
 */

/** A real PNG, built here so the test does not depend on a fixture file. */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC',
  'base64'
);

/** Switches the composer to the model that can read images. */
async function chooseVisionModel(page: Page): Promise<void> {
  await page.locator('.model-trigger').click();
  await page.getByRole('option', { name: 'e2e-vision' }).click();
  await expect(page.locator('.model-trigger')).toContainText('e2e-vision');
}

/** Puts a file into the composer's file input, the way the dialog would. */
async function attach(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[]
): Promise<void> {
  await page.locator('.composer input[type="file"]').setInputFiles(files);
}

test('attach, send, reload, and the image is still there', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await chooseVisionModel(page);

  await attach(page, [{ name: 'red.png', mimeType: 'image/png', buffer: RED_PNG }]);

  // The chip appears and settles into a ready state with its real size.
  const chip = page.locator('.chip');
  await expect(chip).toHaveCount(1);
  await expect(page.locator('.chip--ready')).toHaveCount(1);

  const composer = composerField(page);
  await composer.fill('what colour is this?');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.send('It is red.');
  app.provider.finish();

  // Sent, so the tray empties rather than leaving the file attached to the
  // next message as well.
  await expect(page.locator('.chip')).toHaveCount(0);

  const thumbnail = page.locator('.attachment--image img');
  await expect(thumbnail).toBeVisible();

  /*
   * Reloaded: the conversation comes back from the Markdown on disk, and the
   * image with it. This is the assertion the whole phase is for — the link
   * lives in canonical storage, not in client state.
   */
  await page.reload();
  await expect(page.locator('.attachment--image img')).toBeVisible();

  // And the bytes really are served, not just an element pointing at nothing.
  const loaded = await page
    .locator('.attachment--image img')
    .evaluate((img: HTMLImageElement) => img.naturalWidth > 0);
  expect(loaded).toBe(true);
});

test('an unsupported type is refused, with a reason', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  await attach(page, [
    {
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8'),
    },
  ]);

  const failed = page.locator('.chip--error');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText(/SVG|Markup|not accepted/i);

  // Nothing was attached, so there is nothing to send with.
  await expect(page.locator('.chip--ready')).toHaveCount(0);
});

test('a pasted image is attached', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  /*
   * A paste carrying a file. `DataTransfer` has to be built in the page — the
   * clipboard cannot be populated from the test side — and the event is
   * dispatched on the textarea, which is where a real paste would land.
   */
  await page.evaluate(
    (bytes) => {
      /*
       * Built from the bytes directly rather than by fetching a `data:` URL.
       * The application's CSP sets `connect-src 'self'`, which does not include
       * `data:` — correctly, since nothing here fetches one — so a test that did
       * would be testing the CSP rather than the paste.
       */
      const file = new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' });

      const transfer = new DataTransfer();
      transfer.items.add(file);

      document
        .querySelector('textarea')
        ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
    },
    [...RED_PNG]
  );

  await expect(page.locator('.chip--ready')).toHaveCount(1);
  await expect(page.locator('.chip__name')).toContainText('pasted.png');
});

test('removing a chip discards the file', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  await attach(page, [{ name: 'red.png', mimeType: 'image/png', buffer: RED_PNG }]);
  await expect(page.locator('.chip--ready')).toHaveCount(1);

  await page.getByRole('button', { name: /^Remove / }).click();

  await expect(page.locator('.chip')).toHaveCount(0);
  // And the send button is back to needing something to send.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('an attachment survives in the Markdown, and the file can be downloaded', async ({
  app,
  page,
}) => {
  await signIn(page, app.baseUrl);

  // Text needs no vision, so the default model is the right one here.
  await attach(page, [
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Title\n', 'utf8') },
  ]);
  await expect(page.locator('.chip--ready')).toHaveCount(1);

  const composer = composerField(page);
  await composer.fill('read this');
  await composer.press('Enter');
  await app.provider.waitForStream();
  app.provider.finish();

  const file = page.locator('.attachment--file a');
  await expect(file).toHaveText('notes.md');

  /*
   * Fetched from inside the page, not with `page.request`: the latter is a
   * separate context with no session cookie, so it answers 401 and proves
   * nothing about the headers.
   */
  const href = (await file.getAttribute('href')) ?? '';
  const served = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      nosniff: response.headers.get('x-content-type-options'),
      disposition: response.headers.get('content-disposition'),
      csp: response.headers.get('content-security-policy'),
      body: await response.text(),
    };
  }, href);

  expect(served.status).toBe(200);
  expect(served.type).toBe('text/markdown');
  expect(served.nosniff).toBe('nosniff');
  expect(served.disposition).toMatch(/^attachment;/);
  expect(served.csp).toBe("sandbox; default-src 'none'");
  expect(served.body).toBe('# Title\n');
});

test('a model that cannot see refuses the image, and says why', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  // The default model is text-only, which is the case being tested.
  await attach(page, [{ name: 'red.png', mimeType: 'image/png', buffer: RED_PNG }]);
  await expect(page.locator('.chip--ready')).toHaveCount(1);

  // Warned before sending, rather than only after the server refuses.
  await expect(page.locator('.composer__warning')).toContainText(/cannot read images/i);

  const composer = composerField(page);
  await composer.fill('what is this?');
  await composer.press('Enter');

  // The server is the authority, and it refuses.
  await expect(page.locator('.error-banner')).toContainText(/cannot read images/i);

  /*
   * And nothing was persisted. The capability check runs before the message is
   * written, so the conversation is not left holding a question that could
   * never have been answered.
   */
  await expect(page.locator('.msg')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('attaching works at the narrow breakpoint, and nothing overflows', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    await attach(page, [
      { name: 'red.png', mimeType: 'image/png', buffer: RED_PNG },
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Hi\n', 'utf8') },
    ]);
    await expect(page.locator('.chip--ready')).toHaveCount(2);

    // The chip strip wraps rather than pushing the composer sideways.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows).toBe(false);

    // The attach control and each chip's remove button are still targets a
    // finger can hit, which is the Phase 10 rule applied to Phase 11's UI.
    const undersized = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('.chip__remove, [aria-label="Attach files"]')]
          .map((element) => element.getBoundingClientRect())
          .filter((box) => box.width < 44 || box.height < 44).length
    );
    expect(undersized).toBe(0);

    // And the composer is still reachable above where a keyboard would be.
    await expect(composerField(page)).toBeInViewport();
  });
});
