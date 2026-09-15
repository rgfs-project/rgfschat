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
