import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy to the clipboard, with the brief acknowledgement that follows.
 *
 * The tick is the whole point: a copy button that does nothing visible leaves
 * the reader pressing it again to find out whether it worked. Shared because
 * three places want exactly this and three hand-rolled timers would be three
 * chances to leak one.
 */
export function useCopy(holdMs = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  // A component unmounted inside the window — the panel closed, the message
  // deleted — must not have its state set afterwards.
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(
    (text: string): void => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), holdMs);
        })
        // A refused clipboard is not worth an error message: the reader can
        // still select the text.
        .catch(() => undefined);
    },
    [holdMs]
  );

  return { copied, copy };
}
