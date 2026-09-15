import { useCallback, useLayoutEffect, useReducer, useState } from 'react';

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
}

export function useTailSpace({ port, content, anchorId }: TailSpaceOptions): number {
  const [tail, setTail] = useState(0);

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
      anchorId === null ? null : list?.querySelector(`[data-message-id="${anchorId}"]`);

    if (scroller === null || list === null || anchor === null || anchor === undefined) {
      if (tail !== 0) setTail(0);
      return;
    }

    // Everything from the top of the question to the end of the list, with the
    // reserve already in place taken back out — otherwise each pass would be
    // measuring its own previous answer.
    const occupied =
      list.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top - tail;
    const next = Math.max(0, Math.round(scroller.clientHeight - TOP_GAP_PX - occupied));

    if (Math.abs(next - tail) > EPSILON_PX) setTail(next);
  });

  return tail;
}
