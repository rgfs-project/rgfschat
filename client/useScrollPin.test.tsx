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

/**
 * Nothing survives a conversation change.
 *
 * This hook holds a picture of one transcript: whether the reader had scrolled
 * away from its bottom, where we last put it, whether it overflows at all.
 * None of that describes the next one, and carrying it over is what left a
 * jump-to-latest arrow hanging over an empty New chat — the reader had scrolled
 * up in a long conversation, and `pinned` was still false when a transcript
 * with nothing in it rendered underneath it.
 */
describe('resetting for another conversation', () => {
  it('offers no way back on a transcript that cannot scroll', () => {
    // Content shorter than the viewport: there is no "latest" to jump to.
    const harness = mount(200);
    userScrollTo(harness.element, harness.geometry, 0);

    expect(harness.pin.showJumpToLatest).toBe(false);
  });

  it('offers one on a transcript that can', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 0);

    expect(harness.pin.showJumpToLatest).toBe(true);
  });

  /* The reported sequence: scrolled away in a long chat, then New chat. */
  it('takes the control away when the next transcript is empty', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 0);
    expect(harness.pin.showJumpToLatest).toBe(true);

    act(() => {
      // The new conversation renders: nothing in it, nothing to scroll.
      harness.geometry.set({ scrollHeight: VIEWPORT, scrollTop: 0 });
      harness.pin.reset();
    });

    expect(harness.pin.showJumpToLatest).toBe(false);
    expect(harness.pin.pinned).toBe(true);
  });

  it('takes it away for a short conversation too, not only an empty one', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 0);

    act(() => {
      harness.geometry.set({ scrollHeight: VIEWPORT - 100, scrollTop: 0 });
      harness.pin.reset();
    });

    expect(harness.pin.showJumpToLatest).toBe(false);
  });

  it('starts the new transcript at the bottom, following again', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 0);

    act(() => {
      harness.geometry.set({ scrollHeight: 3000, scrollTop: 0 });
      harness.pin.reset();
    });

    expect(harness.element.scrollTop).toBe(3000);
    expect(harness.pin.pinned).toBe(true);
  });

  /*
   * A guard window left running from the previous conversation would swallow
   * the new one's first real scroll as one of ours, and the reader would find
   * the transcript following the bottom after they had scrolled away from it.
   */
  it('does not swallow the next conversation’s first scroll', () => {
    const harness = mount();

    // A smooth jump opens a guard window, then the conversation changes.
    act(() => {
      harness.pin.jumpToLatest();
    });
    act(() => {
      harness.geometry.set({ scrollHeight: 3000, scrollTop: 2500 });
      harness.pin.reset();
    });

    userScrollTo(harness.element, harness.geometry, 0);

    expect(harness.pin.pinned).toBe(false);
    expect(harness.pin.showJumpToLatest).toBe(true);
  });

  /* Rapid switching: whichever transcript is on screen last is the one the
     state describes, however many resets landed before it. */
  it('describes only the transcript it was last reset on', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 0);

    act(() => {
      harness.geometry.set({ scrollHeight: VIEWPORT, scrollTop: 0 });
      harness.pin.reset();
    });
    act(() => {
      harness.geometry.set({ scrollHeight: 4000, scrollTop: 4000 - VIEWPORT });
      harness.pin.reset();
    });

    // Back in a long one, at its bottom: pinned, and nothing to offer yet.
    expect(harness.pin.pinned).toBe(true);
    expect(harness.pin.showJumpToLatest).toBe(false);

    // And it still behaves as a long transcript once they scroll up again.
    userScrollTo(harness.element, harness.geometry, 0);
    expect(harness.pin.showJumpToLatest).toBe(true);
  });

  it('ignores a scroll event that arrives after the reset', () => {
    const harness = mount();
    userScrollTo(harness.element, harness.geometry, 0);

    act(() => {
      harness.geometry.set({ scrollHeight: VIEWPORT, scrollTop: 0 });
      harness.pin.reset();
    });

    // A late event from the transcript that has just gone: the geometry it
    // reports is the new one's, which is not scrollable.
    act(() => {
      harness.element.dispatchEvent(new Event('scroll'));
    });

    expect(harness.pin.showJumpToLatest).toBe(false);
  });
});
