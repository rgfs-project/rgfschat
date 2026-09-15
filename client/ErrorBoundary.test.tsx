import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.tsx';

/**
 * The boundary component itself, independent of where it is mounted.
 *
 * `state.test.tsx` proves the transcript boundary in situ, against a real
 * conversation payload that makes Markdown throw. That is the right test for
 * "does this region's own bad data get caught", but it says nothing about the
 * boundary mechanism in general — retry, `resetKey`, and the message shown —
 * which every one of the three mounted regions (shell, sidebar, transcript)
 * depends on identically. Proven once here, it does not need proving three
 * times over three different ways of making three different subtrees throw.
 */

function Thrower({ throwing }: { throwing: boolean }): React.JSX.Element {
  if (throwing) throw new Error('boom');
  return <div>content</div>;
}

/**
 * Toggleable from the test, the way a retry actually clears a real failure.
 *
 * A component that threw is unmounted by React along with the rest of the
 * boundary's subtree, so any state *inside* it — a `useState` flag, say — is
 * gone by the time retry remounts it. The flag has to live outside the tree
 * that gets torn down, which a plain mutable box does: read fresh on every
 * render, unaffected by the unmount in between.
 */
function toggleableThrower(initial: boolean): {
  element: React.JSX.Element;
  stopThrowing: () => void;
} {
  const box = { throwing: initial };

  function Harness(): React.JSX.Element {
    return <Thrower throwing={box.throwing} />;
  }

  return { element: <Harness />, stopThrowing: () => (box.throwing = false) };
}

beforeEach(() => {
  // componentDidCatch logs to the console; expected here on every test.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary region="test region">
        <div>all fine</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('all fine')).toBeTruthy();
  });

  it('names the region and shows the error message', () => {
    render(
      <ErrorBoundary region="sidebar">
        <Thrower throwing />
      </ErrorBoundary>
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('sidebar');
    expect(alert.textContent).toContain('boom');
  });

  it('calls onError with the caught error', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary region="test region" onError={onError}>
        <Thrower throwing />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  /**
   * Retry clears the boundary's own state and re-renders the same children.
   * If the underlying cause is still there, it throws again immediately — this
   * proves the *mechanism*, not that any particular failure is fixable.
   */
  it('retry re-renders the children and clears the failure if they no longer throw', async () => {
    const user = userEvent.setup();
    const { element, stopThrowing } = toggleableThrower(true);

    render(<ErrorBoundary region="test region">{element}</ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeTruthy();

    // The underlying condition is resolved before the reader clicks retry —
    // exactly the shape of "the bad conversation was deleted, try again".
    stopThrowing();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('retry alone re-throws immediately if the cause is still present', async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary region="test region">
        <Thrower throwing />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    // Still broken: retry is "try again", not "assume it is fixed".
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  /**
   * `resetKey` is how a parent clears a boundary the reader did not retry
   * themselves — navigating away from the thing that was broken. Used by the
   * transcript boundary, keyed on the conversation id, so opening a different
   * conversation does not keep showing the previous one's crash.
   */
  it('clears the failure when resetKey changes, without a retry click', () => {
    const { rerender } = render(
      <ErrorBoundary region="test region" resetKey="a">
        <Thrower throwing />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    rerender(
      <ErrorBoundary region="test region" resetKey="b">
        <Thrower throwing={false} />
      </ErrorBoundary>
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('does not reset on a re-render that keeps the same resetKey', () => {
    const { rerender } = render(
      <ErrorBoundary region="test region" resetKey="a">
        <Thrower throwing />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    // Same key, children now willing to render cleanly — but nothing asked to
    // look again, so the boundary keeps showing what already failed.
    rerender(
      <ErrorBoundary region="test region" resetKey="a">
        <Thrower throwing={false} />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
