import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGeneration } from './useGeneration.ts';

/**
 * Losing the connection, as distinct from losing the generation.
 *
 * The run belongs to the server and outlives anything the browser does with
 * its stream (INV-06), so a dropped connection is a question about the
 * observation channel and not about the reply. `EventSource` answers it
 * itself — it reconnects, resends `Last-Event-ID`, and the server replays or
 * resyncs — which only works if nothing closes the source out from under it.
 *
 * These drive that boundary directly: a transient drop must leave the source
 * alone, and a fatal one must not leave the caller waiting forever.
 */

interface Fake {
  emit: (name: string, data: unknown, lastEventId?: string) => void;
  /** A drop the browser will retry, as `EventSource` reports it. */
  dropTransiently: () => void;
  /** A drop the browser has given up on — a bad status, or a wrong body. */
  dropFatally: () => void;
  closed: () => boolean;
}

let sources: Fake[] = [];

class TestEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = TestEventSource.OPEN;
  onerror: (() => void) | null = null;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    sources.push({
      emit: (name, data, lastEventId = '1') => {
        const event = new MessageEvent(name, { data: JSON.stringify(data), lastEventId });
        for (const listener of this.#listeners.get(name) ?? []) listener(event);
      },
      dropTransiently: () => {
        // What the browser does before a scheduled retry.
        this.readyState = TestEventSource.CONNECTING;
        this.onerror?.();
      },
      dropFatally: () => {
        this.readyState = TestEventSource.CLOSED;
        this.onerror?.();
      },
      closed: () => this.readyState === TestEventSource.CLOSED,
    });
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.#listeners.get(name) ?? [];
    existing.push(listener);
    this.#listeners.set(name, existing);
  }

  close(): void {
    this.readyState = TestEventSource.CLOSED;
  }
}

beforeEach(() => {
  sources = [];
  vi.stubGlobal('EventSource', TestEventSource);
  // Deltas are batched onto a frame; run it synchronously so a flush is
  // observable inside `act` rather than whenever jsdom feels like it.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function source(): Fake {
  const first = sources[0];
  if (first === undefined) throw new Error('the hook opened no stream');
  return first;
}

describe('observing a generation', () => {
  it('applies a snapshot and the deltas that follow it', () => {
    const { result } = renderHook(() => useGeneration('g1'));

    act(() => {
      source().emit('snapshot', {
        type: 'snapshot',
        snapshot: { content: 'Hel', reasoning: '', state: 'streaming', errorCode: undefined },
      });
      source().emit('content', { type: 'content', delta: 'lo' });
    });

    expect(result.current.content).toBe('Hello');
    expect(result.current.state).toBe('streaming');
  });

  it('closes the stream once the run is done', () => {
    const { result } = renderHook(() => useGeneration('g1'));

    act(() => {
      source().emit('done', { type: 'done', state: 'completed', errorCode: undefined });
    });

    expect(result.current.state).toBe('completed');
    expect(source().closed()).toBe(true);
  });
});

describe('a connection that drops mid-run', () => {
  /**
   * The headline: the stream is left open, because the browser's own retry is
   * the recovery mechanism and closing here would cancel it. Nothing about
   * what has arrived so far changes either — the reply is still running.
   */
  it('leaves a retryable drop to the browser, and keeps the partial reply', () => {
    const { result } = renderHook(() => useGeneration('g1'));

    act(() => {
      source().emit('snapshot', {
        type: 'snapshot',
        snapshot: { content: 'half a ', reasoning: '', state: 'streaming', errorCode: undefined },
      });
      source().dropTransiently();
    });

    expect(source().closed()).toBe(false);
    expect(result.current.state).toBe('streaming');
    expect(result.current.content).toBe('half a ');
  });

  it('accepts the replay that arrives when the browser reconnects', () => {
    const { result } = renderHook(() => useGeneration('g1'));

    act(() => {
      source().emit('snapshot', {
        type: 'snapshot',
        snapshot: { content: 'half a ', reasoning: '', state: 'streaming', errorCode: undefined },
      });
      source().dropTransiently();
      // The server could not replay from where we were, so it resyncs: the
      // whole state replaces what we had rather than appending to it.
      source().emit('resync', {
        type: 'resync',
        snapshot: {
          content: 'half a reply',
          reasoning: '',
          state: 'streaming',
          errorCode: undefined,
        },
      });
      source().emit('done', { type: 'done', state: 'completed', errorCode: undefined });
    });

    expect(result.current.content).toBe('half a reply');
    expect(result.current.state).toBe('completed');
  });

  /**
   * The other half: when the browser has given up there is no retry to wait
   * for, and leaving the state as `streaming` would leave the shell waiting on
   * an event that can no longer arrive. A terminal state is what releases it —
   * and what makes it refetch the conversation, replacing this with the
   * server's own record of how the run actually ended.
   */
  it('reports a terminal state when the browser gives up', () => {
    const { result } = renderHook(() => useGeneration('g1'));

    act(() => {
      source().emit('snapshot', {
        type: 'snapshot',
        snapshot: { content: 'half a ', reasoning: '', state: 'streaming', errorCode: undefined },
      });
      source().dropFatally();
    });

    expect(result.current.state).toBe('failed');
    expect(result.current.content).toBe('half a ');
  });

  it('does not overwrite a run that had already finished', () => {
    const { result } = renderHook(() => useGeneration('g1'));

    act(() => {
      source().emit('done', { type: 'done', state: 'completed', errorCode: undefined });
      // The server closing its end after the last event looks like an error to
      // `EventSource`; it is not one.
      source().dropFatally();
    });

    expect(result.current.state).toBe('completed');
  });
});
