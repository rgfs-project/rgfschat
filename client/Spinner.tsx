/**
 * A turning ring, for anything that is waiting.
 *
 * A component rather than a class, because the markup is not just the circle:
 * every use needs the same `role="status"`, the same `aria-hidden` on the ring,
 * and the same hidden word behind it. A spinner with no accessible name
 * announces nothing at all, and that is exactly the detail a copied `<span
 * className="spinner" />` loses first.
 *
 * Under `prefers-reduced-motion` the ring is dropped and the label takes its
 * place (see `components.css`), so the label is not decoration — it is the
 * whole of what some readers get.
 */

export interface SpinnerProps {
  /**
   * What is loading, read aloud in place of the ring.
   *
   * Worth naming the thing rather than leaving the default: "Loading messages"
   * tells a reader which part of the page is busy, where four identical
   * "Loading" announcements do not.
   */
  label?: string;
  /**
   * Sized to sit in a line of text rather than alone on a page.
   *
   * The full-size ring is for a screen that holds nothing else; in a list row
   * or a chip it would be taller than the row it is in.
   */
  small?: boolean;
}

export function Spinner({ label = 'Loading…', small = false }: SpinnerProps): React.JSX.Element {
  return (
    <span className="spinner-row" role="status">
      <span className={`spinner${small ? ' spinner--small' : ''}`} aria-hidden="true" />
      <span className="spinner__label">{label}</span>
    </span>
  );
}
