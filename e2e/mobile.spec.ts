import { composerField, expect, seedConversations, signIn, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * The responsive layout, at the sizes it has to be right at.
 *
 * None of this can be a component test. Every property here is layout — what is
 * inside the viewport, what scrolls, how large a target is — and jsdom has no
 * layout engine to ask. The focus trap is the one piece with logic worth
 * testing in isolation, and that lives in `client/useFocusTrap.test.tsx`.
 *
 * The breakpoint is 56rem (896px), so the pair either side of it is where a
 * layout that changes at the wrong pixel shows up.
 */

/** The prompt's phone. */
const PHONE = { width: 390, height: 844 };

/**
 * An iPhone 17, measured on the real device: 402x874 at DPR 3, of which Safari
 * leaves 402x714 once its own chrome is accounted for. The prompt names
 * 390x844, which is a different handset, and both are tested — the narrower one
 * because the phase asks for it, this one because it is what the application is
 * actually being read on.
 */
const PHONE_17_VIEWPORT = { width: 402, height: 714 };

const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };
const JUST_NARROW = { width: 895, height: 900 };
const JUST_WIDE = { width: 897, height: 900 };

/** Every element a finger is expected to hit. */
const INTERACTIVE = 'button, a[href], input, textarea, [role="button"], [role="menuitem"]';

async function horizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
}

/**
 * Opens the first seeded conversation from the drawer.
 *
 * On a phone the conversation list is inside a drawer that starts shut, so
 * there is no clicking a conversation without opening it first — and the drawer
 * closes itself once one is chosen, which is what leaves the transcript
 * reachable.
 */
async function openConversation(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.locator('.conversation__open').first().click();
  await expect(page.locator('.shell')).toHaveAttribute('data-sidebar', 'collapsed');
}

/** Whether the document — as opposed to one of its two scrollers — can scroll. */
async function pageScrolls(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
  );
}

test.describe('phone (390x844)', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the drawer takes focus, keeps it, and gives it back', async ({ app, page }) => {
    await seedConversations(app.dataDir, 2);
    await signIn(page, app.baseUrl);

    const trigger = page.getByRole('button', { name: 'Expand sidebar' });
    await trigger.click();

    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();

    // Focus moved into the drawer rather than staying on the page behind it.
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('.sidebar')?.contains(document.activeElement))
      )
      .toBe(true);

    // Tab from the last control wraps to the first rather than escaping.
    await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar')!;
      const items = [...sidebar.querySelectorAll<HTMLElement>('button, input, a[href]')].filter(
        (element) => element.offsetParent !== null
      );
      items[items.length - 1]!.focus();
    });

    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() =>
        document.querySelector('.sidebar')?.contains(document.activeElement)
      )
    ).toBe(true);

    // Escape closes it, and focus returns to the control that opened it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.shell')).toHaveAttribute('data-sidebar', 'collapsed');
    await expect(trigger).toBeFocused();
  });

  test('the page behind the drawer is inert, and the backdrop dismisses it', async ({
    app,
    page,
  }) => {
    await signIn(page, app.baseUrl);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();

    await expect(page.locator('.scrim')).toBeVisible();

    // Not merely hidden from assistive technology — actually unreachable.
    expect(await page.locator('.main').evaluate((element) => element.hasAttribute('inert'))).toBe(
      true
    );

    /*
     * Beside the drawer, not on it. The drawer is 268px wide and sits above the
     * scrim, so a click at x=10 lands on the conversation list — which is what
     * the scrim is there to protect. 340 is past its right edge on a 390px
     * screen and is the only part of the scrim a finger can actually reach.
     */
    await page.locator('.scrim').click({ position: { x: 340, y: 400 } });
    await expect(page.locator('.shell')).toHaveAttribute('data-sidebar', 'collapsed');

    // And it is given back when the drawer closes.
    expect(await page.locator('.main').evaluate((element) => element.hasAttribute('inert'))).toBe(
      false
    );
  });

  test('the composer stays above a simulated keyboard', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await expect(composerField(page)).toBeVisible();

    /*
     * The keyboard as *Chromium* presents it under
     * `interactive-widget=resizes-content`: the layout viewport itself gets
     * shorter, so emulating it as a shorter viewport is the same thing that
     * browser does.
     *
     * It is not what Safari does. Safari has never implemented
     * `interactive-widget`, keeps the layout viewport at full height and
     * shrinks only the visual one — which this emulation cannot reproduce and
     * which is why this test stayed green while a real iPhone put the composer
     * under the keys. That case is handled by `useViewportHeight`, and covered
     * by its own test.
     */
    const keyboardHeight = 336;
    await page.setViewportSize({ width: PHONE.width, height: PHONE.height - keyboardHeight });
    await page.waitForTimeout(200);

    const box = await composerField(page).boundingBox();
    expect(box).not.toBeNull();
    // Wholly inside what is left of the viewport, not under where the keys are.
    expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height - keyboardHeight);
    await expect(composerField(page)).toBeInViewport();

    // And the document still is not the scroller.
    expect(await horizontalOverflow(page)).toBe(false);
    expect(await pageScrolls(page)).toBe(false);
  });

  test('a keyboard opening does not count as scrolling away from the bottom', async ({
    app,
    page,
  }) => {
    await seedConversations(app.dataDir, 1, { messages: 40 });
    await signIn(page, app.baseUrl);
    await openConversation(page);

    const transcript = page.getByTestId('transcript');
    await expect(transcript).toBeVisible();

    // Start at the bottom, which is where a conversation opens.
    await transcript.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await page.waitForTimeout(150);

    /*
     * The keyboard arrives.
     *
     * This is not a scroll and the browser does not report one: `scrollTop`
     * does not move and no `scroll` event is dispatched. What moves is the
     * bottom — the scroller loses ~420px of height — so a transcript left
     * exactly where it was is now that far above the end, with the newest
     * message behind the keys.
     */
    await page.setViewportSize({ width: PHONE.width, height: 420 });
    await page.waitForTimeout(400);

    // Still at the bottom, in the shortened viewport.
    const distance = await transcript.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight
    );
    expect(distance).toBeLessThanOrEqual(48);

    // And still *pinned*, so nothing offered a way back to a place it never left.
    await expect(page.locator('.jump-to-latest')).toHaveCount(0);
  });

  test('survives an orientation change', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    await page.setViewportSize({ width: PHONE.height, height: PHONE.width });
    await page.waitForTimeout(200);
    await expect(composerField(page)).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);

    await page.setViewportSize(PHONE);
    await page.waitForTimeout(200);
    await expect(composerField(page)).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(false);
  });

  test('a wide code block scrolls inside itself, not the page', async ({ app, page }) => {
    // The language matters: a fence with neither a language nor a newline in it
    // is treated as inline code rather than a block (see `Markdown.tsx`).
    await seedConversations(app.dataDir, 1, {
      body: ['```text', 'x'.repeat(400), '```'].join('\n'),
    });
    await signIn(page, app.baseUrl);
    await openConversation(page);

    const pre = page.locator('.code-block pre').first();
    await expect(pre).toBeVisible();

    // The block overflows and scrolls; the page does neither.
    expect(await pre.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(
      true
    );
    expect(await horizontalOverflow(page)).toBe(false);
  });

  test('every interactive control is at least 44x44', async ({ app, page }) => {
    await seedConversations(app.dataDir, 2);
    await signIn(page, app.baseUrl);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();

    const undersized = await page.evaluate((selector) => {
      const round = (value: number): number => Math.round(value * 10) / 10;
      return [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          // Nothing that is not on screen: a control inside the closed account
          // menu is not a target until the menu is open.
          if (box.width === 0 || box.height === 0) return false;

          /*
           * Nor anything deliberately taken out of reach. The composer's file
           * input is one: it is hidden from assistive technology and removed
           * from the tab order, and the button beside it is what a finger
           * actually aims at. Sizing it to 44px would put a 44px invisible
           * control in the layout.
           */
          if (element.getAttribute('aria-hidden') === 'true') return false;
          if (element.tabIndex < 0) return false;

          return box.width < 44 || box.height < 44;
        })
        .map((element) => ({
          what: element.getAttribute('aria-label') ?? element.className,
          width: round(element.getBoundingClientRect().width),
          height: round(element.getBoundingClientRect().height),
        }));
    }, INTERACTIVE);

    expect(undersized, JSON.stringify(undersized, null, 1)).toEqual([]);
  });
});

test.describe('iPhone 17 (402x874, DPR 3)', () => {
  test.use({
    viewport: PHONE_17_VIEWPORT,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  test('lays out inside Safari’s 402x714 viewport', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    await expect(composerField(page)).toBeInViewport();
    expect(await horizontalOverflow(page)).toBe(false);
    expect(await pageScrolls(page)).toBe(false);

    // The drawer covers the page rather than sharing the width with it.
    await expect(page.locator('.shell')).toHaveAttribute('data-narrow', 'true');
  });
});

test.describe('the breakpoint', () => {
  test('is a drawer one pixel below and a column one pixel above', async ({ app, page }) => {
    await page.setViewportSize(JUST_NARROW);
    await signIn(page, app.baseUrl);

    await expect(page.locator('.shell')).toHaveAttribute('data-narrow', 'true');
    // Shut by default on a narrow window, whatever the stored preference says.
    await expect(page.locator('.shell')).toHaveAttribute('data-sidebar', 'collapsed');

    await page.setViewportSize(JUST_WIDE);
    await expect(page.locator('.shell')).toHaveAttribute('data-narrow', 'false');
  });

  test('the CSS and the hook change over at the same pixel', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    /*
     * The two definitions of "narrow" live in different languages — a
     * `matchMedia` string in `useNarrowViewport` and a `@media` block in
     * `components.css` — and cannot reference one another. They had already
     * drifted once, to 56rem against 48rem, leaving a band where the sidebar
     * was a drawer while the panels still laid out for a desktop. This asserts
     * they agree by observing both at the same width.
     */
    await page.setViewportSize(JUST_NARROW);
    await expect(page.locator('.shell')).toHaveAttribute('data-narrow', 'true');
    expect(await page.evaluate(() => window.matchMedia('(max-width: 56rem)').matches)).toBe(true);

    await page.setViewportSize(JUST_WIDE);
    await expect(page.locator('.shell')).toHaveAttribute('data-narrow', 'false');
    expect(await page.evaluate(() => window.matchMedia('(max-width: 56rem)').matches)).toBe(false);
  });
});

test.describe('tablet (820x1180)', () => {
  test.use({ viewport: TABLET });

  test('lays out without horizontal scroll and keeps the composer in view', async ({
    app,
    page,
  }) => {
    await signIn(page, app.baseUrl);
    await expect(composerField(page)).toBeInViewport();
    expect(await horizontalOverflow(page)).toBe(false);
    expect(await pageScrolls(page)).toBe(false);
  });

  test('overlays stay inside the viewport at its edges', async ({ app, page }) => {
    await signIn(page, app.baseUrl);
    await page.locator('.model-trigger').click();

    const menu = page.locator('.model-menu');
    await expect(menu).toBeVisible();

    /*
     * Polled, because the sheet slides up from off-screen: measured on the
     * frame it becomes visible it is still most of a menu below the fold, and
     * the assertion would be about the animation rather than the layout.
     */
    await expect
      .poll(async () => {
        const box = (await menu.boundingBox())!;
        return {
          left: box.x >= 0,
          right: box.x + box.width <= TABLET.width,
          top: box.y >= 0,
          bottom: box.y + box.height <= TABLET.height,
        };
      })
      .toEqual({ left: true, right: true, top: true, bottom: true });
  });
});

test.describe('desktop (1440x900)', () => {
  test.use({ viewport: DESKTOP });

  test('shows the sidebar as a column, not a drawer', async ({ app, page }) => {
    await signIn(page, app.baseUrl);

    await expect(page.locator('.shell')).toHaveAttribute('data-narrow', 'false');
    await expect(page.locator('.scrim')).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(false);

    // Not a dialog, so focus is not trapped in it and nothing is announced as
    // having opened over the page.
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  });

  test('streaming while scrolled up leaves the view where it was', async ({ app, page }) => {
    await seedConversations(app.dataDir, 1, { messages: 60 });
    await signIn(page, app.baseUrl);
    await page.locator('.conversation__open').first().click();

    const transcript = page.getByTestId('transcript');
    await transcript.evaluate((element) => element.scrollTo({ top: 0 }));
    const parked = await transcript.evaluate((element) => element.scrollTop);

    const composer = composerField(page);
    await composer.fill('tell me something');
    await composer.press('Enter');
    await app.provider.waitForStream();
    app.provider.send('a reply that arrives while the reader is elsewhere');
    await page.waitForTimeout(300);

    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(parked);
    app.provider.finish();
  });
});
