import { useEffect, useRef, useState } from 'react';
import type { LiveGeneration } from './useGeneration.ts';

/**
 * One polite live region that narrates a generation to a screen reader.
 *
 * A sighted reader watches the reply stream in; a screen-reader user is told
 * nothing by that motion. This announces the two moments that matter — the
 * reply started, and how it ended — and deliberately **not** each token: a
 * region that changed on every token would talk over itself continuously and
 * drown the reply it is announcing.
 *
 * `polite`, so it waits for a pause rather than interrupting. It renders only
 * text into an off-screen region and never moves focus or touches the scroll
 * position, so it cannot disturb what the reader is doing (contracts / the
 * Phase 14 requirement: it never steals focus and never changes scroll
 * pinning). The element is always present and only its text changes — an
 * `aria-live` region that is added to the DOM at the same time as its content
 * is not reliably announced.
 */

const MESSAGE: Record<string, string> = {
  pending: 'Assistant is responding.',
  streaming: 'Assistant is responding.',
  completed: 'Response complete.',
  cancelled: 'Response cancelled.',
  failed: 'Response failed.',
  timed_out: 'Response timed out.',
};

export function GenerationAnnouncer({
  state,
}: {
  state: LiveGeneration['state'];
}): React.JSX.Element {
  const [message, setMessage] = useState('');
  const lastPhase = useRef<'active' | 'terminal' | 'idle'>('idle');

  useEffect(() => {
    // Collapse the token-by-token `streaming` updates to a single phase, so
    // the effect only speaks on a real transition, not on every re-render.
    const phase =
      state === 'pending' || state === 'streaming'
        ? 'active'
        : state === 'idle'
          ? 'idle'
          : 'terminal';

    if (phase === lastPhase.current) return;
    lastPhase.current = phase;

    if (phase === 'idle') {
      // Cleared silently — an empty region makes no announcement.
      setMessage('');
      return;
    }
    setMessage(MESSAGE[state] ?? '');
  }, [state]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
