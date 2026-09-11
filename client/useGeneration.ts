import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationEvent, GenerationSnapshotDto } from '@shared/generation.ts';
import { isTerminal } from '@shared/generation.ts';
import { generationStreamUrl } from './api.ts';

export interface LiveGeneration {
  content: string;
  reasoning: string;
  state: GenerationSnapshotDto['state'] | 'idle';
  errorCode: string | undefined;
}

const IDLE: LiveGeneration = {
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
  const [live, setLive] = useState<LiveGeneration>(IDLE);
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
      setLive(IDLE);
      return;
    }

    setLive({ content: '', reasoning: '', state: 'pending', errorCode: undefined });
    pending.current = { content: '', reasoning: '' };

    const source = new EventSource(generationStreamUrl(generationId));

    const handle = (raw: MessageEvent<string>): void => {
      let event: GenerationEvent;
      try {
        event = JSON.parse(raw.data) as GenerationEvent;
      } catch {
        return;
      }

      switch (event.type) {
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

    for (const name of ['snapshot', 'content', 'reasoning', 'state', 'done']) {
      source.addEventListener(name, handle as EventListener);
    }

    // A transport error after a terminal state is just the server closing.
    source.onerror = () => {
      setLive((prev) => (isTerminal(prev.state as never) ? prev : prev));
      source.close();
    };

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      source.close();
    };
  }, [generationId, schedule, flush]);

  return live;
}
