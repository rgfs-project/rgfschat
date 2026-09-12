import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap.ts';

/**
 * The trap's logic, away from any layout.
 *
 * What a jsdom test can settle is the wiring: that focus is moved in, that Tab
 * at either end wraps instead of escaping, that Escape is reported, and that
 * focus is handed back to whatever opened the overlay. What it cannot settle is
 * whether the element was *visible* enough to accept focus in the first place —
 * jsdom has no layout, so `offsetParent` is null for everything and a real
 * browser's refusal to focus a `visibility: hidden` element is not reproduced.
 * That half is `e2e/mobile.spec.ts`.
 */

function Overlay({
  open,
  onEscape,
  empty = false,
}: {
  open: boolean;
  onEscape?: () => void;
  empty?: boolean;
}): React.JSX.Element {
  const ref = useFocusTrap<HTMLDivElement>({
    active: open,
    ...(onEscape === undefined ? {} : { onEscape }),
  });

  return (
    <div>
      <button type="button">outside</button>
      {open && (
        <div ref={ref} data-testid="overlay">
          {!empty && (
            <>
              <button type="button">first</button>
              <button type="button">middle</button>
              <button type="button">last</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Focus is moved on the next animation frame, so tests have to let one pass.
 * jsdom implements `requestAnimationFrame` on a timer, hence the real wait
 * rather than fake timers — which would also have to drive React's own work.
 */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

/*
 * The hook asks `offsetParent` whether a control is laid out, and jsdom answers
 * null for everything because it has no layout — so without this every control
 * reads as hidden and the trap would focus its own container in every test.
 *
 * Stood up by hand rather than worked around, which is what this suite already
 * does for scroll geometry. The stand-in draws the same distinction the real
 * property does: null inside a `display: none` subtree, the parent otherwise.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement): Element | null {
      let node: HTMLElement | null = this.parentElement;
      if (window.getComputedStyle(this).display === 'none') return null;
      for (; node !== null; node = node.parentElement) {
        if (window.getComputedStyle(node).display === 'none') return null;
      }
      return this.parentElement;
    },
  });
});

describe('useFocusTrap', () => {
  it('moves focus into the overlay when it opens', async () => {
    render(<Overlay open />);
    await nextFrame();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('focuses the container itself when it holds nothing focusable', async () => {
    render(<Overlay open empty />);
    await nextFrame();

    expect(document.activeElement).toBe(screen.getByTestId('overlay'));
  });

  it('does nothing at all while inactive', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    render(<Overlay open={false} />);
    await nextFrame();

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('wraps Tab from the last control back to the first', async () => {
    const user = userEvent.setup();
    render(<Overlay open />);
    await nextFrame();

    screen.getByRole('button', { name: 'last' }).focus();
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('wraps Shift+Tab from the first control back to the last', async () => {
    const user = userEvent.setup();
    render(<Overlay open />);
    await nextFrame();

    screen.getByRole('button', { name: 'first' }).focus();
    await user.tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'last' }));
  });

  it('pulls focus back when it has left the overlay entirely', async () => {
    const user = userEvent.setup();
    render(<Overlay open />);
    await nextFrame();

    screen.getByRole('button', { name: 'outside' }).focus();
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));
  });

  it('reports Escape', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(<Overlay open onEscape={onEscape} />);
    await nextFrame();

    await user.keyboard('{Escape}');

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('restores focus to whatever opened it', async () => {
    const user = userEvent.setup();

    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <Overlay open={open} onEscape={() => setOpen(false)} />
        </div>
      );
    }

    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'open' });

    await user.click(trigger);
    await nextFrame();
    // Focus left the trigger and went into the overlay.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'first' }));

    await user.keyboard('{Escape}');

    // Closed, and the trigger has it back — not the document body.
    expect(screen.queryByTestId('overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
