import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps the transcript pinned to the bottom, but only while the user wants it.
 *
 * The hard part is telling a *user* scroll from one the browser or we caused.
 * A streaming reply changes `scrollHeight` constantly, and every one of our own
 * `scrollTo` calls fires `scroll` too. If those counted as intent, reading back
 * through a long answer would be yanked to the bottom on the next token — the
 * single most irritating bug this component can have.
 *
 * So scroll origin is tracked explicitly rather than inferred: we set a flag
 * around our own scrolls and ignore events while it is set. Everything else is
 * the user.
 */

/** Below this, the transcript fits and there is nowhere to jump to. */
const SCROLLABLE_EPSILON_PX = 1;

/** How close to the bottom still counts as pinned. */
const PIN_THRESHOLD_PX = 48;

/** How far a reported position may drift and still be the one we set. */
const POSITION_EPSILON_PX = 2;

/** How long a smooth scroll is allowed to keep emitting events. */
const SMOOTH_GUARD_MS = 400;

/**
 * How long after a viewport resize a scroll event is still the resize's fault.
 *
 * Opening the on-screen keyboard shortens the layout viewport, which shortens
 * the transcript, which moves `scrollTop` — and the browser dispatches a
 * `scroll` event for it. Nobody scrolled. Without this guard, tapping the
 * composer at the bottom of a conversation silently unpinned the transcript,
 * and the next token of the reply arrived somewhere the reader could not see.
 *
 * Long enough to cover the reflow and the animation the keyboard slides in on,
 * short enough that a real scroll a moment later is still read as one.
 */
const RESIZE_GUARD_MS = 250;

export interface ScrollPin {
  ref: React.RefObject<HTMLDivElement | null>;
  /** Whether new content should follow the bottom. */
  pinned: boolean;
  /**
   * Scrolled away from the bottom of a transcript that can be scrolled.
   *
   * Both halves matter. A conversation with nothing in it, or one short enough
   * to fit, has no "latest" to go back to — offering the control there is a
   * button that does nothing, and it is exactly what a stale `pinned` from the
   * conversation before produced: the arrow hanging over an empty New chat.
   */
  showJumpToLatest: boolean;
  /** Scrolls to the bottom and re-pins. Safe to call from a click handler. */
  jumpToLatest: () => void;
  /** Follows the end again from here on, and goes there now. */
  pin: () => void;
  /** Stops following the end, leaving the view exactly where it is. */
  release: () => void;
  /** Call whenever rendered content changes (new token, new message). */
  onContentChange: () => void;
  /**
   * Forgets everything and starts again at the bottom.
   *
   * For a conversation change, which is not a scroll: none of what this holds
   * — pinned or not, the position we last set, the guard windows, whether the
   * thing is scrollable at all — describes the transcript that is now on
   * screen. Carried over, they are read against the new one, which is how a
   * reader who had scrolled up in a long chat arrived at an empty New chat with
   * a jump-to-latest arrow over it.
   */
  reset: () => void;
  /**
   * Moves the view by `delta` without it counting as the reader scrolling.
   *
   * For a layout change that would otherwise move what the reader is looking
   * at — the tail reserve shrinking is the one that matters — where the
   * correction is "put it back", not "go to the bottom".
   */
  adjustBy: (delta: number) => void;
}

export function useScrollPin(): ScrollPin {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  /**
   * Whether there is anything to scroll, measured rather than assumed.
   *
   * Starts false: a transcript that has not been measured yet has nothing to
   * go back to, and starting true would flash the control on every open.
   */
  const [scrollable, setScrollable] = useState(false);

  /**
   * The pinned flag again, readable synchronously.
   *
   * `onContentChange` runs on every token. If it read the *state*, it would see
   * whatever value was current when the callback was last built — so a token
   * arriving in the gap between a user's scroll and React re-rendering would
   * still be treated as pinned, scroll the viewport back down, and swallow the
   * unpin (every scroll event it then caused is our own, and ignored). Reading
   * a ref closes that window.
   */
  const pinnedRef = useRef(true);

  /**
   * Whether the *reader* took the view somewhere, as opposed to us letting go
   * of the bottom.
   *
   * `release` and a deliberate scroll both leave the transcript unpinned, and
   * they are not the same thing at all: after `release` nothing is following
   * the bottom but the view is still ours to hold steady, while after a scroll
   * the position belongs to the reader and must not be touched by anything —
   * which is what `adjustBy` checks before it moves anything.
   */
  const userScrolled = useRef(false);

  /**
   * Where our own instant scroll landed, so its event can be recognised.
   *
   * An instant `scrollTo` moves `scrollTop` synchronously but dispatches the
   * event later, so the position is already final by the time we see it: if it
   * matches, the event is ours. Matching on *position* rather than on a time
   * window matters — a window ignores every scroll that happens to fall inside
   * it, including a real one, which is exactly how a user scrolling during a
   * stream gets dragged back to the bottom.
   */
  const programmaticTop = useRef<number | null>(null);

  /**
   * A smooth scroll cannot use that trick: it emits a run of events at
   * intermediate positions, none of which match the destination. It only
   * happens on an explicit "jump to latest", where the user has just asked to
   * be taken to the bottom, so a short time window is the right tool there.
   */
  const smoothUntil = useRef(0);
  const smoothTimer = useRef<number | null>(null);

  /** Set while a viewport resize could still be producing scroll events. */
  const resizeUntil = useRef(0);

  const isAtBottom = useCallback((element: HTMLElement): boolean => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distance <= PIN_THRESHOLD_PX;
  }, []);

  /** Re-reads whether this transcript overflows its viewport at all. */
  const measureScrollable = useCallback((element: HTMLElement): void => {
    setScrollable(element.scrollHeight - element.clientHeight > SCROLLABLE_EPSILON_PX);
  }, []);

  const scrollToBottom = useCallback((element: HTMLElement, smooth: boolean): void => {
    if (smooth) {
      if (smoothTimer.current !== null) window.clearTimeout(smoothTimer.current);
      smoothUntil.current = Date.now() + SMOOTH_GUARD_MS;
      smoothTimer.current = window.setTimeout(() => {
        smoothUntil.current = 0;
        smoothTimer.current = null;
      }, SMOOTH_GUARD_MS);

      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
      return;
    }

    // Recorded before the scroll, and clamped the way the browser will clamp
    // it: asking for `scrollHeight` lands at `scrollHeight - clientHeight`, and
    // that smaller number is what the event will report.
    programmaticTop.current = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }, []);

  /** Attaches the scroll listener that decides pinned/unpinned. */
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const onScroll = (): void => {
      // Ours, not theirs: carries no intent.
      if (Date.now() < smoothUntil.current) return;

      /*
       * The viewport's, not theirs. A resize that leaves the transcript at the
       * bottom re-pins rather than merely being ignored: shortening the
       * container can push `scrollTop` past the threshold on its own, and
       * ignoring that would leave a transcript that is visibly at the bottom
       * marked as scrolled away.
       */
      if (Date.now() < resizeUntil.current) {
        if (isAtBottom(element)) {
          pinnedRef.current = true;
          setPinned(true);
        }
        return;
      }

      if (
        programmaticTop.current !== null &&
        Math.abs(element.scrollTop - programmaticTop.current) <= POSITION_EPSILON_PX
      ) {
        // Consume it; a later event at this position is the user resting here.
        programmaticTop.current = null;
        return;
      }

      const atBottom = isAtBottom(element);
      pinnedRef.current = atBottom;
      // Scrolling back to the bottom is the reader handing the view back.
      userScrolled.current = !atBottom;
      setPinned(atBottom);
      measureScrollable(element);
    };

    /*
     * Both events, because they are different questions on a phone.
     *
     * `window.resize` fires when the layout viewport changes — which, under
     * `interactive-widget=resizes-content`, is what the keyboard does. But a
     * browser that does not honour that hint leaves the layout viewport alone
     * and only moves the *visual* one, and there `visualViewport.resize` is the
     * single signal there is. This is the one place `visualViewport` is used
     * (the prompt asks for that to be justified): it is not being measured, it
     * is being listened to as evidence that the reader did not scroll.
     */
    const markResize = (): void => {
      resizeUntil.current = Date.now() + RESIZE_GUARD_MS;

      /*
       * The bottom moved, so follow it.
       *
       * Shortening the scroller does not move `scrollTop`, and the browser
       * fires no `scroll` event for it — measured: `clientHeight` 635 → 211
       * with `scrollTop` unchanged and zero events. So a reader who was at the
       * bottom is silently left 424px above it, with the newest message under
       * the keyboard, and nothing in the scroll path ever learns about it.
       *
       * Re-pinning here is what keeps "at the bottom" meaning the same thing
       * before and after the keyboard opens. The guard above handles the
       * opposite direction, where the viewport *grows* and the browser clamps
       * `scrollTop` down — that one does emit an event, and it is not intent
       * either.
       */
      if (pinnedRef.current) scrollToBottom(element, false);
    };

    // Measured once on mount, so a transcript that already overflows is known
    // to before the first scroll event that might never come.
    measureScrollable(element);

    element.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', markResize);
    window.visualViewport?.addEventListener('resize', markResize);

    return () => {
      element.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', markResize);
      window.visualViewport?.removeEventListener('resize', markResize);
    };
  }, [isAtBottom, measureScrollable, scrollToBottom]);

  useEffect(
    () => () => {
      if (smoothTimer.current !== null) window.clearTimeout(smoothTimer.current);
    },
    []
  );

  const onContentChange = useCallback((): void => {
    const element = ref.current;
    if (element === null) return;

    // Whether there is anywhere to jump to changes with the content, and this
    // is the one call that happens every time the content changes.
    measureScrollable(element);

    // Unpinned, the viewport is left exactly where the reader put it; the
    // jump control is their way back, and it is already on screen.
    if (pinnedRef.current) scrollToBottom(element, false);
  }, [measureScrollable, scrollToBottom]);

  /**
   * Nudges the view, and owns the scroll event it causes.
   *
   * Recorded as programmatic for the same reason every other scroll here is:
   * an adjustment the reader did not make must not be read as them scrolling
   * away, which would unpin the transcript mid-reply.
   */
  const adjustBy = useCallback((delta: number): void => {
    const element = ref.current;
    if (element === null || !Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
    // Once the reader has taken the view somewhere, it is theirs: content
    // growing under them is not a reason to move it, which is the whole of
    // "streaming while scrolled up does not move the viewport".
    if (userScrolled.current) return;

    const limit = Math.max(0, element.scrollHeight - element.clientHeight);
    const next = Math.max(0, Math.min(limit, element.scrollTop + delta));
    if (Math.abs(next - element.scrollTop) < 0.5) return;

    programmaticTop.current = next;
    element.scrollTop = next;
  }, []);

  /*
   * Let go of the end without moving.
   *
   * Used when an answer has outgrown the room reserved for it: up to that
   * point following the bottom is what holds the question at the top of the
   * screen, and past it the same following would drag the reader down the page
   * a line at a time while they are still reading the top of the answer. The
   * jump control appears in the same moment, which is the way back down.
   */
  const release = useCallback((): void => {
    pinnedRef.current = false;
    setPinned(false);
    // Deliberately *not* `userScrolled`: nobody scrolled, we stopped following.
    // The view is still ours to hold steady against layout moving under it.
  }, []);

  /** Asking a question means wanting to see it, wherever the view had got to. */
  const pin = useCallback((): void => {
    const element = ref.current;
    pinnedRef.current = true;
    userScrolled.current = false;
    setPinned(true);
    programmaticTop.current = null;
    if (element !== null) scrollToBottom(element, false);
  }, [scrollToBottom]);

  /**
   * Starts over on a transcript this hook has never seen.
   *
   * Everything that could outlive the switch is dropped here: the pinned flag
   * and its ref, the position we last scrolled to, the smooth-scroll and resize
   * guard windows along with the timer that would have cleared them, and the
   * scrollable measurement. A guard window left running would swallow the new
   * conversation's first real scroll as "ours"; a stale `programmaticTop` would
   * match a position in it by coincidence and do the same.
   */
  const reset = useCallback((): void => {
    if (smoothTimer.current !== null) {
      window.clearTimeout(smoothTimer.current);
      smoothTimer.current = null;
    }
    smoothUntil.current = 0;
    resizeUntil.current = 0;
    programmaticTop.current = null;

    pinnedRef.current = true;
    userScrolled.current = false;
    setPinned(true);
    setScrollable(false);

    const element = ref.current;
    if (element === null) return;

    // The canonical position for a transcript nobody has scrolled yet: the
    // bottom, which for an empty one is also the top.
    element.scrollTop = element.scrollHeight;
    measureScrollable(element);
  }, [measureScrollable]);

  const jumpToLatest = useCallback((): void => {
    const element = ref.current;
    if (element === null) return;

    scrollToBottom(element, true);
    programmaticTop.current = null;
    pinnedRef.current = true;
    userScrolled.current = false;
    setPinned(true);
  }, [scrollToBottom]);

  return {
    ref,
    pinned,
    showJumpToLatest: !pinned && scrollable,
    jumpToLatest,
    pin,
    release,
    onContentChange,
    adjustBy,
    reset,
  };
}
