import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useScrollPin, type ScrollPin } from './useScrollPin.ts';
import { stubScrollGeometry } from './test-setup.ts';

/**
 * Scroll intent (contracts: auto-scroll only while pinned).
 *
 * The rule being protected here is that *our* scrolls and content growth never
 * count as user intent — only a scroll the user actually performed may unpin.
 * Getting that wrong is invisible in a static render and only shows up as the
 * viewport yanking to the bottom mid-read, so each case drives the real
 * listener with real geometry rather than asserting on internal state.
 */

const VIEWPORT = 500;

/** Mounts the hook on a div with controllable scroll geometry. */
function mount(contentHeight = 2000) {
  let pin!: ScrollPin;

  function Harness(): React.JSX.Element {
    pin = useScrollPin();
    return <div data-testid="scroller" ref={pin.ref} />;
  }

  const view = render(<Harness />);
  const element = view.getByTestId('scroller');

  const geometry = stubScrollGeometry(element, {
    scrollHeight: contentHeight,
    clientHeight: VIEWPORT,
    // Mounted at the bottom, which is where a fresh transcript starts.
    scrollTop: contentHeight - VIEWPORT,
  });

  return {
    get pin() {
      return pin;
    },
    element,
    geometry,
    view,
  };
}

/** Simulates a scroll the *user* performed. */
function userScrollTo(
  element: HTMLElement,
  geometry: ReturnType<typeof stubScrollGeometry>,
  top: number
): void {
  act(() => {
    geometry.set({ scrollTop: top });
    element.dispatchEvent(new Event('scroll'));
  });
}

describe('useScrollPin', () => {
  it('starts pinned', () => {
    expect(mount().pin.pinned).toBe(true);
  });

  it('unpins when the user scrolls away from the bottom', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 200);
    expect(harness.pin.pinned).toBe(false);
  });

  it('stays pinned for a scroll that lands within the threshold', () => {
    const harness = mount();
    // 1500 is the exact bottom; 1470 is 30px short of it, inside the 48px band.
    userScrollTo(harness.element, harness.geometry, 1470);
    expect(harness.pin.pinned).toBe(true);
  });

  it('re-pins when the user scrolls back to the bottom', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 200);
    expect(harness.pin.pinned).toBe(false);

    userScrollTo(harness.element, harness.geometry, 1500);
    expect(harness.pin.pinned).toBe(true);
  });

  it('follows the bottom on new content while pinned', () => {
    const harness = mount();

    act(() => {
      harness.geometry.set({ scrollHeight: 3000 });
      harness.pin.onContentChange();
    });

    expect(harness.geometry.scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: 'auto' });
  });

  it('does not move the viewport on new content while unpinned', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 200);
    harness.geometry.scrollTo.mockClear();

    act(() => {
      harness.geometry.set({ scrollHeight: 3000 });
      harness.pin.onContentChange();
    });

    expect(harness.geometry.scrollTo).not.toHaveBeenCalled();
    expect(harness.element.scrollTop).toBe(200);
  });

  /**
   * The regression this hook exists for. Our own `scrollTo` fires a `scroll`
   * event; if that event were treated as user intent it would immediately
   * unpin, and every subsequent token would stop following.
   */
  it('does not let its own scroll count as user intent', () => {
    const harness = mount();

    act(() => {
      harness.geometry.set({ scrollHeight: 4000 });
      // The stub scrolls and fires the event, exactly as the browser does.
      harness.pin.onContentChange();
    });

    expect(harness.pin.pinned).toBe(true);
  });

  /**
   * Origin is decided by *position*, not by a time window. A window ignores
   * every scroll that lands inside it — so a user scrolling up in the moment
   * after a token arrived was treated as ours and dragged back to the bottom.
   */
  it('honours a user scroll that immediately follows one of its own', () => {
    const harness = mount();

    act(() => {
      harness.geometry.set({ scrollHeight: 4000 });
      harness.pin.onContentChange();
    });
    expect(harness.pin.pinned).toBe(true);

    // No timers advanced: this is the very next event.
    userScrollTo(harness.element, harness.geometry, 0);
    expect(harness.pin.pinned).toBe(false);
  });

  it('keeps following the bottom across a burst of content', () => {
    const harness = mount();

    act(() => {
      for (let height = 2500; height <= 5000; height += 500) {
        harness.geometry.set({ scrollHeight: height });
        harness.pin.onContentChange();
      }
    });

    expect(harness.pin.pinned).toBe(true);
    expect(harness.element.scrollTop).toBe(4500);
  });

  describe('jump to latest', () => {
    it('is hidden while pinned', () => {
      const harness = mount();
      act(() => {
        harness.pin.onContentChange();
      });
      expect(harness.pin.showJumpToLatest).toBe(false);
    });

    it('appears as soon as the user scrolls away', () => {
      const harness = mount();
      userScrollTo(harness.element, harness.geometry, 200);
      expect(harness.pin.showJumpToLatest).toBe(true);
    });

    it('stays while content arrives underneath', () => {
      const harness = mount();
      userScrollTo(harness.element, harness.geometry, 200);

      act(() => {
        harness.geometry.set({ scrollHeight: 3000 });
        harness.pin.onContentChange();
      });

      expect(harness.pin.showJumpToLatest).toBe(true);
      // And the viewport was still not moved out from under them.
      expect(harness.element.scrollTop).toBe(200);
    });

    it('scrolls to the bottom, re-pins, and dismisses itself', () => {
      const harness = mount();
      userScrollTo(harness.element, harness.geometry, 200);
      act(() => {
        harness.geometry.set({ scrollHeight: 3000 });
      });

      act(() => {
        harness.pin.jumpToLatest();
      });

      expect(harness.geometry.scrollTo).toHaveBeenCalledWith({ top: 3000, behavior: 'smooth' });
      expect(harness.pin.pinned).toBe(true);
      expect(harness.pin.showJumpToLatest).toBe(false);
    });

    it('is dismissed by scrolling back down by hand', () => {
      const harness = mount();
      userScrollTo(harness.element, harness.geometry, 200);
      expect(harness.pin.showJumpToLatest).toBe(true);

      userScrollTo(harness.element, harness.geometry, 2500);
      expect(harness.pin.showJumpToLatest).toBe(false);
    });
  });
});
