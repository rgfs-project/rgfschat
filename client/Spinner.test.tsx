import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spinner } from './Spinner.tsx';

/**
 * The shared spinner.
 *
 * Every assertion here is about the part that is easy to lose when the markup
 * is copied rather than imported: the ring is decoration, and the word behind
 * it is the only thing a screen reader — or anyone with motion suppressed —
 * actually gets.
 */

describe('Spinner', () => {
  it('announces itself as a status', () => {
    render(<Spinner />);

    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('carries a default label', () => {
    render(<Spinner />);

    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  /* Four identical "Loading" announcements tell a reader nothing about which
     part of the page is busy. */
  it('names what is loading when told', () => {
    render(<Spinner label="Loading conversations…" />);

    expect(screen.getByText('Loading conversations…')).toBeTruthy();
  });

  /* The ring repeats what the label already says, so it must not be announced
     a second time. */
  it('hides the ring from assistive technology', () => {
    const { container } = render(<Spinner />);

    expect(container.querySelector('.spinner')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('is full size by default and small on request', () => {
    const { container, rerender } = render(<Spinner />);
    expect(container.querySelector('.spinner')?.className).toBe('spinner');

    rerender(<Spinner small />);
    expect(container.querySelector('.spinner')?.className).toContain('spinner--small');
  });
});
