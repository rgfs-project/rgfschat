import { useEffect, useRef } from 'react';

/**
 * Keeps focus inside an overlay while it is open, and gives it back when it
 * closes.
 *
 * Three behaviours, which are one behaviour from the reader's side.
 *
 * **Focus goes in.** An overlay that opens without moving focus leaves the
 * keyboard on the page underneath it: Tab walks a drawer's worth of controls
 * nobody can see, and a screen reader is never told that anything opened.
 *
 * **Focus stays in.** Tab from the last control wraps to the first rather than
 * escaping to the page behind. Implemented on `keydown` rather than with
 * sentinel elements because the page behind is already marked `inert` — a
 * sentinel would be a second mechanism doing the same job, and the two would
 * eventually disagree.
 *
 * **Focus comes back.** Whatever opened the overlay is focused again on close,
 * so dismissing a drawer does not drop the reader at the top of the document.
 *
 * Escape is handled here too, since every overlay in this application closes
 * that way and each one writing its own listener is how one of them ends up not
 * doing it.
 */

/** What can hold focus, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  /** An inactive trap does nothing, so a mounted-but-closed overlay is free. */
  active?: boolean;
  onEscape?: () => void;
}

export function useFocusTrap<T extends HTMLElement>(
  options: FocusTrapOptions = {}
): React.RefObject<T | null> {
  const { active = true, onEscape } = options;
  const container = useRef<T | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    const element = container.current;
    if (element === null) return;

    // Read before focus moves, because moving it is the next thing done.
    restoreTo.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (candidate) => candidate.offsetParent !== null || candidate === document.activeElement
      );

    /**
     * Moves focus in, and reports whether it went.
     *
     * The container itself is the fallback when it holds nothing focusable —
     * a list that has not loaded yet must not leave focus outside the overlay.
     */
    const focusFirst = (): boolean => {
      const first = focusable()[0];
      if (first === undefined) element.tabIndex = -1;
      const target = first ?? element;
      target.focus();
      return document.activeElement === target;
    };

    /*
     * Synchronously first, so there is no frame in which the overlay is up and
     * the keyboard is still on the page behind it. This is the path the sidebar
     * drawer takes: its open rule makes it visible with no transition, so it is
     * focusable on the frame its class lands.
     *
     * The retry covers an overlay that is not rendered yet at that instant. A
     * browser refuses focus for an unrendered element *silently* — no throw, no
     * return value — so the only way to find out is to ask what actually holds
     * focus afterwards. One frame is not a cure for everything: an overlay that
     * transitions `visibility` over a duration is still hidden on the next
     * frame too, which is why that is fixed in the stylesheet rather than here.
     */
    const frame = focusFirst() ? 0 : requestAnimationFrame(() => void focusFirst());

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && onEscape !== undefined) {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const current = document.activeElement;

      // Wrapping is only this hook's business at the two ends — and whenever
      // focus has somehow left the container entirely.
      if (!element.contains(current)) {
        event.preventDefault();
        firstItem.focus();
      } else if (event.shiftKey && current === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && current === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);

      /*
       * Restored only if focus is still this overlay's to give back. Something
       * else may have taken it deliberately while the overlay was closing — a
       * dialog opened from inside it, say — and stealing it back from there
       * would be worse than not restoring at all.
       */
      const previous = restoreTo.current;
      if (previous === null || !previous.isConnected) return;

      const now = document.activeElement;
      if (now === null || now === document.body || element.contains(now)) previous.focus();
    };
  }, [active, onEscape]);

  return container;
}
