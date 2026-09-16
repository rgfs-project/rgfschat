import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationEvent, GenerationSnapshotDto } from '@shared/generation';
import { isTerminal } from '@shared/generation';
import { generationStreamUrl } from './api.ts';

export interface LiveGeneration {
  content: string;
  reasoning: string;
  state: GenerationSnapshotDto['state'] | 'idle';
  errorCode: string | undefined;
}

/**
 * Nothing running, and what a transcript renders from when the generation that
 * *is* running belongs to another conversation.
 */
export const IDLE_GENERATION: LiveGeneration = {
  content: '',
  reasoning: '',
  state: 'idle',
  errorCode: undefined,
};

/**
 * Observes a server-owned generation over SSE.
 *
 * The stream is an observation channel, not a control channel: closing it (by
 * navigating away, reloading, or passing `null`) never cancels the generation
 * (INV-06). Re-attaching replays the current snapshot first, so a reload picks
 * up mid-flight output without gaps.
 */
export function useGeneration(generationId: string | null): LiveGeneration {
  const [live, setLive] = useState<LiveGeneration>(IDLE_GENERATION);
  /**
   * Highest event id applied.
   *
   * EventSource replays this as `Last-Event-ID` on its own reconnects, and the
   * server replays or resyncs from it. The client never deduplicates to
   * compensate for the server — if text arrived twice, that is a server bug and
   * hiding it here would only make it harder to find.
   */
  const lastEventId = useRef(0);
  // Deltas arrive far faster than React should re-render; they are accumulated
  // here and flushed on an animation frame.
  const pending = useRef<{ content: string; reasoning: string }>({ content: '', reasoning: '' });
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    const { content, reasoning } = pending.current;
    if (content === '' && reasoning === '') return;
    pending.current = { content: '', reasoning: '' };

    setLive((prev) => ({
      ...prev,
      content: prev.content + content,
      reasoning: prev.reasoning + reasoning,
    }));
  }, []);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    if (generationId === null) {
      setLive(IDLE_GENERATION);
      return;
    }

    setLive({ content: '', reasoning: '', state: 'pending', errorCode: undefined });
    pending.current = { content: '', reasoning: '' };
    lastEventId.current = 0;

    const source = new EventSource(generationStreamUrl(generationId));

    const handle = (raw: MessageEvent<string>): void => {
      let event: GenerationEvent;
      try {
        event = JSON.parse(raw.data) as GenerationEvent;
      } catch {
        return;
      }

      const id = Number.parseInt(raw.lastEventId, 10);
      if (Number.isFinite(id)) lastEventId.current = id;

      switch (event.type) {
        case 'resync':
          // The server could not replay from where we were, so it handed over
          // the whole state. Replace rather than append: what we had may
          // overlap or be missing events entirely.
          flush();
          pending.current = { content: '', reasoning: '' };
          setLive({
            content: event.snapshot.content,
            reasoning: event.snapshot.reasoning,
            state: event.snapshot.state,
            errorCode: event.snapshot.errorCode,
          });
          break;
        case 'snapshot':
          setLive({
            content: event.snapshot.content,
            reasoning: event.snapshot.reasoning,
            state: event.snapshot.state,
            errorCode: event.snapshot.errorCode,
          });
          break;
        case 'content':
          pending.current.content += event.delta;
          schedule();
          break;
        case 'reasoning':
          pending.current.reasoning += event.delta;
          schedule();
          break;
        case 'state':
          setLive((prev) => ({ ...prev, state: event.state }));
          break;
        case 'done':
          flush();
          setLive((prev) => ({ ...prev, state: event.state, errorCode: event.errorCode }));
          source.close();
          break;
      }
    };

    for (const name of ['snapshot', 'resync', 'content', 'reasoning', 'state', 'done']) {
      source.addEventListener(name, handle as EventListener);
    }

    /*
     * A dropped connection is not a failed generation.
     *
     * `EventSource` reconnects by itself, and this stream is built for it: the
     * browser resends `Last-Event-ID` and the server replays — or resyncs —
     * from there. Closing the source here took that away, so a momentary blip
     * mid-reply left the run going on the server with nothing watching it, and
     * the reader looking at a loader that never resolved.
     *
     * `readyState` tells the two cases apart. `CONNECTING` means a retry is
     * already scheduled and there is nothing to do. `CLOSED` means the browser
     * has given up — a non-2xx status or a body that was not an event stream —
     * and no retry is coming, so the run is genuinely no longer observable
     * from here. Reporting that as a terminal state is what lets the shell
     * stop waiting and refetch the conversation, which replaces this guess
     * with whatever the server actually stored.
     */
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      setLive((prev) =>
        prev.state === 'idle' || isTerminal(prev.state)
          ? prev
          : { ...prev, state: 'failed', errorCode: undefined }
      );
    };

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      source.close();
    };
  }, [generationId, schedule, flush]);

  return live;
}
