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

export interface ScrollPin {
  ref: React.RefObject<HTMLDivElement | null>;
  /** Whether new content should follow the bottom. */
  pinned: boolean;
  /** Scrolled away from the bottom, so a way back is worth offering. */
  showJumpToLatest: boolean;
  /** Scrolls to the bottom and re-pins. Safe to call from a click handler. */
  jumpToLatest: () => void;
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

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [isAtBottom]);

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
    onContentChange,
  };
}
