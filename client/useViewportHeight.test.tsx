import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewportHeight } from './useViewportHeight.ts';

/**
 * Sizing the application to the visible viewport.
 *
 * The bug this covers is Safari's, and Safari is not what runs these tests —
 * so what is checked is the mechanism: that the visual viewport is published,
 * that it keeps up, and that it is cleaned up. The `100dvh` fallback in the
 * stylesheet is what handles a browser with no `visualViewport` at all, which
 * is why an absent one must be a silent no-op rather than a crash.
 */

interface FakeViewport {
  height: number;
  offsetTop: number;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  emit: (type: string) => void;
  listeners: Map<string, Set<() => void>>;
}

function fakeViewport(height: number, offsetTop = 0): FakeViewport {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop,
    listeners,
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function install(viewport: FakeViewport | undefined): void {
  Object.defineProperty(window, 'visualViewport', {
    value: viewport,
    configurable: true,
    writable: true,
  });
}

const height = (): string | null =>
  document.documentElement.style.getPropertyValue('--viewport-height') || null;
const offset = (): string | null =>
  document.documentElement.style.getPropertyValue('--viewport-offset') || null;

afterEach(() => {
  document.documentElement.removeAttribute('style');
  install(undefined);
  vi.restoreAllMocks();
});

/** The hook coalesces to a frame, so the test has to run them. */
function runFrames(): void {
  const queued = frames.splice(0, frames.length);
  for (const fn of queued) fn(0);
}
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

describe('useViewportHeight', () => {
  it('publishes the visible height as soon as it mounts', () => {
    install(fakeViewport(714));

    renderHook(() => useViewportHeight());

    expect(height()).toBe('714px');
    expect(offset()).toBe('0px');
  });

  /*
   * The keyboard opening, as Safari presents it: the layout viewport is
   * untouched, the visual one shrinks, and the page is panned so the focused
   * field is visible. Both numbers have to move or the shell sits over the
   * wrong part of the screen.
   */
  it('follows the viewport when a keyboard opens', () => {
    const viewport = fakeViewport(874);
    install(viewport);
    renderHook(() => useViewportHeight());

    act(() => {
      viewport.height = 538;
      viewport.offsetTop = 60;
      viewport.emit('resize');
      runFrames();
    });

    expect(height()).toBe('538px');
    expect(offset()).toBe('60px');
  });

  it('follows a pan on its own, without a resize', () => {
    const viewport = fakeViewport(538, 0);
    install(viewport);
    renderHook(() => useViewportHeight());

    act(() => {
      viewport.offsetTop = 120;
      viewport.emit('scroll');
      runFrames();
    });

    expect(offset()).toBe('120px');
  });

  /*
   * Reading `height` is a layout read and writing the property invalidates
   * layout, so one write per event would be a forced reflow per event — during
   * the one animation that has to stay smooth.
   */
  it('writes once for a burst of events, not once each', () => {
    const viewport = fakeViewport(874);
    install(viewport);
    renderHook(() => useViewportHeight());

    act(() => {
      viewport.height = 538;
      viewport.emit('resize');
      viewport.emit('resize');
      viewport.emit('scroll');
      expect(frames).toHaveLength(1);
      runFrames();
    });

    expect(height()).toBe('538px');
  });

  it('leaves no stale height behind when it unmounts', () => {
    install(fakeViewport(538));
    const { unmount } = renderHook(() => useViewportHeight());
    expect(height()).toBe('538px');

    unmount();

    // A height frozen at whatever the keyboard last made it is worse than none:
    // the stylesheet's `100dvh` fallback is correct, a stale number never is.
    expect(height()).toBeNull();
    expect(offset()).toBeNull();
  });

  it('does nothing at all where there is no visual viewport', () => {
    install(undefined);

    expect(() => renderHook(() => useViewportHeight())).not.toThrow();
    expect(height()).toBeNull();
  });
});
