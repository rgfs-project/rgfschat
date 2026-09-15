import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTailSpace } from './useTailSpace.ts';

/**
 * jsdom lays nothing out: every box is 0x0 and `clientHeight` is 0. So the two
 * measurements the hook takes are stubbed, and the list's own height is made to
 * depend on the spacer the hook sets — which is what a real reflow would do,
 * and what the fixed point it converges on is about.
 */

const PORT_HEIGHT = 800;
const TOP_GAP = 24;

function Harness({ anchorHeight, anchorId }: { anchorHeight: number; anchorId: string | null }) {
  const port = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const tail = useTailSpace({ port, content, anchorId });

  const stubPort = (node: HTMLDivElement | null): void => {
    port.current = node;
    if (node === null) return;
    Object.defineProperty(node, 'clientHeight', { value: PORT_HEIGHT, configurable: true });
  };

  /*
   * The list ends where the anchor's content ends plus whatever the spacer is
   * currently holding, so the hook's own output feeds back into what it
   * measures next — exactly as a browser would report it.
   */
  const stubContent = (node: HTMLDivElement | null): void => {
    content.current = node;
    if (node === null) return;
    node.getBoundingClientRect = () => ({ bottom: anchorHeight + tail, top: 0 }) as DOMRect;
  };

  const stubAnchor = (node: HTMLDivElement | null): void => {
    if (node === null) return;
    node.getBoundingClientRect = () => ({ top: 0, bottom: anchorHeight }) as DOMRect;
  };

  return (
    <div ref={stubPort}>
      <div ref={stubContent}>
        <div ref={stubAnchor} data-message-id="m1" />
      </div>
      <output data-testid="tail">{tail}</output>
    </div>
  );
}

const tailValue = (): number => Number(screen.getByTestId('tail').textContent);

describe('useTailSpace', () => {
  it('reserves whatever the last turn does not fill', () => {
    render(<Harness anchorHeight={100} anchorId="m1" />);

    // 800 of viewport, 24 held above the question, 100 taken by the turn.
    expect(tailValue()).toBe(PORT_HEIGHT - TOP_GAP - 100);
  });

  it('reserves nothing once the turn is taller than the viewport', () => {
    render(<Harness anchorHeight={PORT_HEIGHT + 200} anchorId="m1" />);

    expect(tailValue()).toBe(0);
  });

  it('reserves nothing when there is no question to put at the top', () => {
    render(<Harness anchorHeight={100} anchorId={null} />);

    expect(tailValue()).toBe(0);
  });

  it('reserves nothing when the anchor is not in the list', () => {
    render(<Harness anchorHeight={100} anchorId="gone" />);

    expect(tailValue()).toBe(0);
  });

  it('settles rather than growing on its own output', () => {
    const { rerender } = render(<Harness anchorHeight={100} anchorId="m1" />);
    const settled = tailValue();

    rerender(<Harness anchorHeight={100} anchorId="m1" />);
    rerender(<Harness anchorHeight={100} anchorId="m1" />);

    expect(tailValue()).toBe(settled);
  });

  it('gives the space back as the answer grows into it', () => {
    const { rerender } = render(<Harness anchorHeight={100} anchorId="m1" />);
    const before = tailValue();

    rerender(<Harness anchorHeight={400} anchorId="m1" />);

    expect(tailValue()).toBe(before - 300);
  });
});

/**
 * The question must not slide away while the answer streams.
 *
 * This is the bug the screenshots showed: partway through a long reply the
 * transcript exposed the previous exchange again and the question the reader
 * was following ended up near the bottom of the screen. Nobody scrolled.
 *
 * Once the reserve is gone the transcript is released and `scrollTop` stops
 * moving — which holds the question still only if nothing above it changes
 * height. Things above it do: every flush re-renders the whole transcript, and
 * an earlier answer with a table in it re-lays its columns out, growing by
 * hundreds of pixels and pushing everything below it down the screen.
 *
 * jsdom lays nothing out, so the shift is modelled directly: the history above
 * the anchor grows while the scroll position is untouched, which is exactly
 * what the browser does to it.
 */
describe('holding the question still while content above it changes', () => {
  const PORT = PORT_HEIGHT;

  interface View {
    scrollTop: number;
    /**
     * Whether the reader has taken the view somewhere themselves.
     *
     * The real `adjustBy` refuses while this is set — that is where the rule
     * lives, in the one place that can tell its own scrolls from theirs — so
     * the stand-in here refuses on the same condition.
     */
    userScrolled?: boolean;
  }

  /** The anchor's viewport coordinate, the thing that must not move down. */
  const anchorTopOf = (history: number, view: View): number => history - view.scrollTop;

  function DriftHarness({
    history,
    answerHeight,
    view,
    withFix = true,
  }: {
    history: number;
    answerHeight: number;
    view: View;
    withFix?: boolean;
  }) {
    const port = useRef<HTMLDivElement | null>(null);
    const content = useRef<HTMLDivElement | null>(null);

    /* The scroll pin's `adjustBy`: move the view, clamped as a browser would. */
    const adjustBy = (delta: number): void => {
      if (view.userScrolled === true) return;
      const limit = Math.max(0, history + answerHeight + tail - PORT);
      view.scrollTop = Math.max(0, Math.min(limit, view.scrollTop + delta));
    };

    const tail = useTailSpace({
      port,
      content,
      anchorId: 'm1',
      ...(withFix ? { adjustBy } : {}),
    });

    const stubPort = (node: HTMLDivElement | null): void => {
      port.current = node;
      if (node === null) return;
      Object.defineProperty(node, 'clientHeight', { value: PORT, configurable: true });
      Object.defineProperty(node, 'scrollTop', {
        get: () => view.scrollTop,
        set: (next: number) => {
          view.scrollTop = next;
        },
        configurable: true,
      });
    };

    const stubContent = (node: HTMLDivElement | null): void => {
      content.current = node;
      if (node === null) return;
      node.getBoundingClientRect = () =>
        ({
          top: -view.scrollTop,
          bottom: history + answerHeight + tail - view.scrollTop,
        }) as DOMRect;
    };

    const stubAnchor = (node: HTMLDivElement | null): void => {
      if (node === null) return;
      node.getBoundingClientRect = () =>
        ({ top: anchorTopOf(history, view), bottom: 0 }) as DOMRect;
    };

    return (
      <div ref={stubPort}>
        <div ref={stubContent}>
          <div ref={stubAnchor} data-message-id="m1" />
        </div>
        <output data-testid="tail">{tail}</output>
      </div>
    );
  }

  /** Starts with the answer already past the reserve, as it is when this bites. */
  const START_HISTORY = 2_000;
  const LONG_ANSWER = PORT_HEIGHT + 400;

  it('takes an upward growth above the question back out of the scroll', () => {
    const view: View = { scrollTop: START_HISTORY - TOP_GAP };
    const { rerender } = render(
      <DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />
    );
    const settled = anchorTopOf(START_HISTORY, view);

    // A table in an earlier answer finishes laying out: 300px appears above.
    const grown = START_HISTORY + 300;
    rerender(<DriftHarness history={grown} answerHeight={LONG_ANSWER} view={view} />);

    expect(anchorTopOf(grown, view)).toBeLessThanOrEqual(settled + 1);
  });

  /* Without the correction the same growth is exactly what the reader saw: the
     question 300px further down the screen, with the previous turn back in view. */
  it('is what stops the question sliding down the screen', () => {
    const view: View = { scrollTop: START_HISTORY - TOP_GAP };
    const { rerender } = render(
      <DriftHarness
        history={START_HISTORY}
        answerHeight={LONG_ANSWER}
        view={view}
        withFix={false}
      />
    );
    const settled = anchorTopOf(START_HISTORY, view);

    const grown = START_HISTORY + 300;
    rerender(
      <DriftHarness history={grown} answerHeight={LONG_ANSWER} view={view} withFix={false} />
    );

    expect(anchorTopOf(grown, view)).toBe(settled + 300);
  });

  it('leaves a scroll the reader made alone', () => {
    const view: View = { scrollTop: START_HISTORY - TOP_GAP };
    const { rerender } = render(
      <DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />
    );

    // The reader scrolls up into the history themselves, which is what the pin
    // records; from here the position is theirs.
    view.scrollTop -= 500;
    view.userScrolled = true;
    const chosen = view.scrollTop;
    rerender(<DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />);

    expect(view.scrollTop).toBe(chosen);
  });

  it('leaves the question alone when nothing moves', () => {
    const view: View = { scrollTop: START_HISTORY - TOP_GAP };
    const { rerender } = render(
      <DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />
    );
    const settled = view.scrollTop;

    rerender(<DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />);
    rerender(<DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />);

    expect(view.scrollTop).toBe(settled);
  });

  it('reserves nothing once the answer has outgrown the viewport', () => {
    const view: View = { scrollTop: 0 };
    render(<DriftHarness history={START_HISTORY} answerHeight={LONG_ANSWER} view={view} />);

    expect(tailValue()).toBe(0);
  });
});
