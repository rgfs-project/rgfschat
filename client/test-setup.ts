import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Shared setup for the jsdom project.
 *
 * jsdom implements no layout, so everything the scroll logic reads —
 * `scrollHeight`, `clientHeight`, `scrollTo` — is either a hard-coded 0 or
 * missing entirely. `stubScrollGeometry` below installs a working stand-in so
 * the pin/unpin rules can be exercised against real numbers instead of being
 * asserted indirectly.
 */

/*
 * jsdom implements no scrolling at all, so `Element.scrollTo` is simply absent
 * and any component that calls it throws on mount. A no-op default lets those
 * components render; tests that care about scrolling install a working stub
 * over the top with `stubScrollGeometry`.
 */
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => undefined;
}

afterEach(() => {
  cleanup();
});

export interface ScrollGeometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/**
 * Gives one element a mutable scroll geometry and a `scrollTo` that actually
 * moves `scrollTop` and fires a `scroll` event, the way a browser would.
 */
export function stubScrollGeometry(
  element: HTMLElement,
  initial: ScrollGeometry
): { set: (next: Partial<ScrollGeometry>) => void; scrollTo: ReturnType<typeof vi.fn> } {
  const state = { ...initial };

  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => state.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });

  const scrollTo = vi.fn((options: ScrollToOptions) => {
    // Clamped like a real scroller: a request beyond the end lands at the end,
    // which is the position the resulting event reports.
    const max = Math.max(0, state.scrollHeight - state.clientHeight);
    state.scrollTop = Math.min(options.top ?? state.scrollTop, max);
    element.dispatchEvent(new Event('scroll'));
  });
  element.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];

  return {
    set: (next) => {
      Object.assign(state, next);
    },
    scrollTo,
  };
}
