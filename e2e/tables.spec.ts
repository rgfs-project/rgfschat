import { expect, signIn, startGeneration, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * A comparison table, laid out by a real browser.
 *
 * Everything that went wrong here is layout, and jsdom has none: the headings
 * chopped mid-word came from squeezing every column into the message's width,
 * and the columns past the edge were unreachable because the wrapper's
 * scrollbar was the only way to them. So these are measured on the page —
 * widths, overflow, and what actually scrolls.
 */

const TABLE = [
  '',
  '| Element | Nvidia (RTX 40xx) | AMD (RX 7900) |',
  '| --- | --- | --- |',
  '| Architectures | Ada Lovelace plus Turing with dedicated RT cores | RDNA 3 and RDNA 4 across the range |',
  '| Ray-tracing cores | Fully dedicated, about twice as fast in Ada | Slower per core; RDNA 4 improves it |',
  '| Tensor/AI acceleration | Dedicated tensor cores for DLSS | No dedicated cores; general compute |',
  '| Identifier | 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928 | urn:example:very-long-unbroken-identifier |',
  '',
].join('\n');

/** The transcript's own horizontal overflow, which must always be none. */
async function overflow(page: Page): Promise<{ page: number; transcript: number }> {
  return page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="transcript"]');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      transcript: transcript === null ? 0 : transcript.scrollWidth - transcript.clientWidth,
    };
  });
}

async function streamTable(
  page: Page,
  app: { provider: { send: (text: string) => void; waitForStream: () => Promise<void> } }
): Promise<void> {
  await startGeneration(page, 'nvidia vs amd');
  await app.provider.waitForStream();
  app.provider.send('Here is the comparison.\n\n');
  app.provider.send(TABLE);
  await expect(page.locator('table')).toBeVisible();
}

test('a wide table scrolls itself, and nothing else does', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await streamTable(page, app);

  const wrapper = page.locator('.table-scroll');
  const scrollable = await wrapper.evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(scrollable).toBe(true);

  // The page and the transcript stay put: only the wrapper moves sideways.
  expect(await overflow(page)).toEqual({ page: 0, transcript: 0 });
});

test('the table stays inside the message it belongs to', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await streamTable(page, app);

  const message = await page.locator('.msg--assistant').last().boundingBox();
  const wrapper = await page.locator('.table-scroll').boundingBox();

  expect(wrapper?.width).toBeLessThanOrEqual((message?.width ?? 0) + 1);
});

/*
 * The reported symptom: a heading of one ordinary word broken across lines
 * ("Architect / ures") because the column was two characters narrower than the
 * word. A cell's text is one line taller than its font only when it wrapped.
 */
test('ordinary words are not broken inside a cell', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await streamTable(page, app);

  const broken = await page.locator('table').evaluate((table) => {
    const range = document.createRange();
    for (const cell of table.querySelectorAll('th, td')) {
      const text = cell.textContent ?? '';
      // A single word must occupy a single line box.
      for (const word of text.split(/\s+/).filter((part) => part.length > 2)) {
        const index = text.indexOf(word);
        const node = cell.firstChild;
        if (node === null || node.nodeType !== Node.TEXT_NODE) continue;
        if (index < 0 || index + word.length > (node.textContent ?? '').length) continue;
        range.setStart(node, index);
        range.setEnd(node, index + word.length);
        if (range.getClientRects().length > 1) return { cell: text, word };
      }
    }
    return null;
  });

  expect(broken).toBeNull();
});

test('headers stay above their own columns', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await streamTable(page, app);

  const aligned = await page.locator('table').evaluate((table) => {
    const heads = [...table.querySelectorAll('thead th')].map((cell) =>
      cell.getBoundingClientRect()
    );
    const cells = [...table.querySelectorAll('tbody tr:first-child td')].map((cell) =>
      cell.getBoundingClientRect()
    );
    return heads.every((head, index) => Math.abs(head.left - (cells[index]?.left ?? -1)) < 1);
  });

  expect(aligned).toBe(true);
});

test('the table can be scrolled from the keyboard', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await streamTable(page, app);

  const wrapper = page.locator('.table-scroll');
  await wrapper.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  expect(await wrapper.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  // And it never dragged the transcript sideways with it.
  expect(await overflow(page)).toEqual({ page: 0, transcript: 0 });
});

test('the table can be scrolled by dragging it, as a touch would', async ({ app, page }) => {
  await signIn(page, app.baseUrl);
  await streamTable(page, app);

  const wrapper = page.locator('.table-scroll');
  await wrapper.evaluate((node) => {
    node.scrollLeft = 200;
  });

  expect(await wrapper.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await overflow(page)).toEqual({ page: 0, transcript: 0 });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the table scrolls in place and the page does not', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await streamTable(page, app);

    expect(await overflow(page)).toEqual({ page: 0, transcript: 0 });
    expect(
      await page.locator('.table-scroll').evaluate((node) => node.scrollWidth > node.clientWidth)
    ).toBe(true);
  });

  test('cells keep readable padding', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await streamTable(page, app);

    const padding = await page
      .locator('table td')
      .first()
      .evaluate((cell) => parseFloat(getComputedStyle(cell).paddingLeft));

    expect(padding).toBeGreaterThanOrEqual(6);
  });
});

/*
 * A table arrives a row at a time, and each row changes its height — and,
 * while the columns settle, its width. Neither may move the question the
 * reader is following.
 */
test('a table growing as it streams does not move the anchored question', async ({ app, page }) => {
  await signIn(page, app.baseUrl);

  await startGeneration(page, 'first');
  await app.provider.waitForStream();
  app.provider.send('An answer.\n\n'.repeat(20));
  app.provider.finish();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();

  const composer = page.getByLabel('Message', { exact: true });
  await composer.fill('nvidia vs amd');
  await composer.press('Enter');
  await app.provider.waitForStream();

  await expect(page.locator('.msg--user').last()).toContainText('nvidia vs amd');
  let lowest = (await page.locator('.msg--user').last().boundingBox())?.y ?? 0;

  const lines = TABLE.split('\n');
  for (const line of lines) {
    app.provider.send(`${line}\n`);
    await page.waitForTimeout(120);

    const box = await page.locator('.msg--user').last().boundingBox();
    if (box === null) break;
    expect(box.y).toBeLessThanOrEqual(lowest + 2);
    lowest = Math.min(lowest, box.y);
  }

  app.provider.finish();
});
