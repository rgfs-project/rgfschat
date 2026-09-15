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
  /** Scrolled away from the bottom, so a way back is worth offering. */
  showJumpToLatest: boolean;
  /** Scrolls to the bottom and re-pins. Safe to call from a click handler. */
  jumpToLatest: () => void;
  /** Follows the end again from here on, and goes there now. */
  pin: () => void;
  /** Stops following the end, leaving the view exactly where it is. */
  release: () => void;
  /** Call whenever rendered content changes (new token, new message). */
  onContentChange: () => void;
}

export function useScrollPin(): ScrollPin {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

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
      setPinned(atBottom);
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

    element.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', markResize);
    window.visualViewport?.addEventListener('resize', markResize);

    return () => {
      element.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', markResize);
      window.visualViewport?.removeEventListener('resize', markResize);
    };
  }, [isAtBottom, scrollToBottom]);

  useEffect(
    () => () => {
      if (smoothTimer.current !== null) window.clearTimeout(smoothTimer.current);
    },
    []
  );

  const onContentChange = useCallback((): void => {
    const element = ref.current;
    if (element === null) return;

    // Unpinned, the viewport is left exactly where the reader put it; the
    // jump control is their way back, and it is already on screen.
    if (pinnedRef.current) scrollToBottom(element, false);
  }, [scrollToBottom]);

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
  }, []);

  /** Asking a question means wanting to see it, wherever the view had got to. */
  const pin = useCallback((): void => {
    const element = ref.current;
    pinnedRef.current = true;
    setPinned(true);
    programmaticTop.current = null;
    if (element !== null) scrollToBottom(element, false);
  }, [scrollToBottom]);

  const jumpToLatest = useCallback((): void => {
    const element = ref.current;
    if (element === null) return;

    scrollToBottom(element, true);
    programmaticTop.current = null;
    pinnedRef.current = true;
    setPinned(true);
  }, [scrollToBottom]);

  return {
    ref,
    pinned,
    showJumpToLatest: !pinned,
    jumpToLatest,
    pin,
    release,
    onContentChange,
  };
}
