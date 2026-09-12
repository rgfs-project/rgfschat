import { useSyncExternalStore } from 'react';

/**
 * Whether the window is too narrow to show the sidebar beside a readable
 * transcript.
 *
 * Below this the sidebar is forced shut rather than merely overlapping more of
 * the page: at ~800px an open 22rem sidebar covers nearly half the window, and
 * whatever the reader came for is behind it.
 *
 * `useSyncExternalStore` rather than an effect and a state: the value is read
 * during render from a source React does not own, which is exactly what this
 * hook exists for. It also means the first render already has the right answer,
 * so the sidebar never flashes open on a narrow window before an effect closes
 * it.
 */
/**
 * Kept in step with `--breakpoint-narrow` in `theme.css`, which is where the
 * number is explained. A custom property cannot be read from a media query, so
 * this is a copy rather than a reference; `e2e/mobile.spec.ts` tests the
 * boundary at ±1px, which is what fails if the two ever drift apart again.
 */
const QUERY = '(max-width: 56rem)';

/**
 * `matchMedia` is not universally present — jsdom does not implement it — so
 * every use is guarded and the absent case reports "not narrow". A layout
 * helper must never be the reason a component cannot render.
 */
function media(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const list = media();
  if (list === null) return () => undefined;
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return media()?.matches ?? false;
}

/** The server render has no window; a wide layout is the safer default. */
function getServerSnapshot(): boolean {
  return false;
}

export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
