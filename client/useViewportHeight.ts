import { useEffect } from 'react';

/**
 * Keeps the application the size of what is actually on screen.
 *
 * `100dvh` was the whole of the keyboard-avoidance strategy, resting on
 * `interactive-widget=resizes-content` in the viewport meta: the keyboard
 * shortens the *layout* viewport, `dvh` resolves to the space left above the
 * keys, and the composer follows with no measurement at all.
 *
 * That is true in Chromium, which is where `interactive-widget` is implemented.
 * **Safari does not implement it**, and ignores the key entirely. There the
 * layout viewport keeps its full height when the keyboard opens and only the
 * *visual* viewport shrinks — so `100dvh` never changes, the composer stays at
 * the bottom of a shell that is now taller than the screen, and Safari pans the
 * visual viewport to bring the focused field into view. The result is the bug
 * this fixes: the composer under the keyboard and Safari's own toolbar, and the
 * header scrolled off the top of the page.
 *
 * `useScrollPin` already says this out loud — "a browser that does not honour
 * that hint leaves the layout viewport alone and only moves the visual one" —
 * it was simply never applied to the height of the shell itself.
 *
 * So the visual viewport is published as two custom properties and the shell is
 * sized from them. On Chromium they agree with `dvh` and nothing changes; where
 * `visualViewport` is missing entirely the properties are never set and the
 * `100dvh` fallback in the stylesheet still applies.
 */

/** Set on the root element, read by every full-height container. */
const HEIGHT = '--viewport-height';
const OFFSET = '--viewport-offset';

export function useViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === undefined || viewport === null) return;

    const root = document.documentElement;
    let frame = 0;

    const apply = (): void => {
      /*
       * `offsetTop` is the other half, and the reason the header disappeared.
       *
       * With `html, body { overflow: hidden }` there is no page for Safari to
       * scroll, so it pans the visual viewport instead: the top of the layout
       * is pushed off the screen while the shell stays where it was. Moving the
       * shell down by the same amount puts it back over what is visible.
       */
      root.style.setProperty(HEIGHT, `${viewport.height}px`);
      root.style.setProperty(OFFSET, `${viewport.offsetTop}px`);
    };

    /*
     * Coalesced to a frame.
     *
     * Both events fire in bursts while the keyboard animates in, and each one
     * writes a property that invalidates layout. Reading `height` is itself a
     * layout read, so writing on every event is a forced reflow per event
     * during the one animation that has to stay smooth.
     */
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };

    apply();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      // Removed rather than left behind: a stale height frozen at whatever the
      // keyboard last made it would be worse than no value at all.
      root.style.removeProperty(HEIGHT);
      root.style.removeProperty(OFFSET);
    };
  }, []);
}
