import { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';

/**
 * Empty height held under the last turn, so that asking a question puts it at
 * the top of the screen.
 *
 * The whole trick is the spacer. Reserve exactly enough room below the last
 * turn that "scrolled to the bottom" and "that question at the top" are the
 * same position, and everything else — the send, the follow during streaming,
 * the jump-to-latest control — keeps aiming at the bottom and gets this for
 * free. Nothing else has to know about it.
 *
 * As the answer arrives it eats into the reserve, which shrinks to nothing:
 * a long reply scrolls the question up and off the top exactly as it always
 * did, and a short one leaves the pair sitting together at the top with the
 * space below them.
 *
 * ## Holding the question still once the reserve is gone
 *
 * Up to the moment the reserve runs out, following the bottom is what keeps the
 * question at the top: the spacer shrinks by exactly what the answer grows, so
 * the scrollable height does not change and the position holds. Past it the
 * transcript is released — following further would drag the reader down the
 * page while they are still reading — and from then on `scrollTop` is fixed,
 * which is only the same thing as *the question is fixed* if nothing above it
 * changes height.
 *
 * Things above it do change height. Every flush re-renders the whole
 * transcript, and an earlier answer containing a table lays its columns out
 * again as the new one streams in; a tall enough change up there pushes
 * everything below it down the screen, so the question the reader was following
 * slides away from the top and the previous exchange comes back into view. That
 * is the jump, and it happens in the middle of a reply nobody scrolled.
 *
 * So the anchor's screen position is recorded on every pass, and a drift
 * downwards that nobody scrolled for is taken back out of `scrollTop`.
 * Downwards only: the question moving *up* and off the top is what a long
 * answer is supposed to do.
 */

/** How far below the top edge the question sits. */
const TOP_GAP_PX = 24;

/** Smaller changes than this are the rounding of a reflow, not a new layout. */
const EPSILON_PX = 1;

export interface TailSpaceOptions {
  /** The scroll container. */
  port: React.RefObject<HTMLElement | null>;
  /** The element holding the turns, including this spacer. */
  content: React.RefObject<HTMLElement | null>;
  /**
   * `data-message-id` of the turn to put at the top — the last question asked.
   * `null` when there is none, which reserves nothing.
   */
  anchorId: string | null;
  /**
   * Moves the view without it counting as the reader scrolling.
   *
   * Supplied by the scroll pin, which is the only thing that can tell its own
   * scrolls from theirs; an adjustment made behind its back would be read as
   * the reader scrolling away and would unpin the transcript mid-reply.
   */
  adjustBy?: (delta: number) => void;
}

export function useTailSpace({ port, content, anchorId, adjustBy }: TailSpaceOptions): number {
  const [tail, setTail] = useState(0);

  /**
   * Where the anchor was on screen last time, and where the view was.
   *
   * Both, because the question being asked is "did this move without anyone
   * scrolling": the anchor moving while `scrollTop` is unchanged is layout
   * shifting above it, and is the only case worth correcting. The anchor moving
   * because the reader scrolled is the reader scrolling.
   */
  const previous = useRef<{ id: string; top: number; scrollTop: number } | null>(null);

  /*
   * A resize changes `clientHeight` without changing anything React renders, so
   * nothing would re-run the measurement below. This exists only to ask for the
   * render that does.
   */
  const [, remeasure] = useReducer((count: number) => count + 1, 0);

  const onResize = useCallback((): void => remeasure(), []);

  useLayoutEffect(() => {
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [onResize]);

  /*
   * Deliberately every render, with no dependency list.
   *
   * What is being measured is the rendered height of the last turn, which
   * changes with the text in it, the width it wraps at, whether its reasoning
   * is open, whether an image finished decoding — none of which is a value this
   * hook is given. The measurement subtracts the spacer already in place, so
   * running it again on its own result is a fixed point rather than a loop.
   */
  /* eslint-disable-next-line react-hooks/exhaustive-deps */
  useLayoutEffect(() => {
    const scroller = port.current;
    const list = content.current;
    const anchor =
      anchorId === null ? null : (list?.querySelector(`[data-message-id="${anchorId}"]`) ?? null);

    if (scroller === null || list === null || anchor === null) {
      previous.current = null;
      if (tail !== 0) setTail(0);
      return;
    }

    /*
     * Put the question back where it was, if it moved on its own.
     *
     * Only when `scrollTop` is exactly what it was: then nothing scrolled and
     * the movement is content above the anchor having changed height — a table
     * in an earlier answer re-laying out, an image finishing, the previous
     * turn's reasoning block opening. Taking the difference back out of
     * `scrollTop` leaves the question where the reader was reading it.
     *
     * Downwards only, because up is what a long answer legitimately does to it.
     */
    const top = anchor.getBoundingClientRect().top;
    const before = previous.current;
    if (
      before !== null &&
      before.id === anchorId &&
      before.scrollTop === scroller.scrollTop &&
      adjustBy !== undefined
    ) {
      const moved = top - before.top;
      if (moved > EPSILON_PX) adjustBy(moved);
    }

    // Everything from the top of the question to the end of the list, with the
    // reserve already in place taken back out — otherwise each pass would be
    // measuring its own previous answer.
    const occupied =
      list.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top - tail;
    const next = Math.max(0, Math.round(scroller.clientHeight - TOP_GAP_PX - occupied));

    // Recorded after any correction, so the next pass compares against where
    // the question actually ended up.
    previous.current = {
      id: anchorId as string,
      top: anchor.getBoundingClientRect().top,
      scrollTop: scroller.scrollTop,
    };

    if (Math.abs(next - tail) > EPSILON_PX) setTail(next);
  });

  return tail;
}
