import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GenerationAnnouncer } from './GenerationAnnouncer.tsx';
import type { LiveGeneration } from './useGeneration.ts';

/**
 * The live region's behaviour — the part a screen reader depends on and axe
 * cannot see.
 */

const region = (): HTMLElement => screen.getByRole('status');

describe('GenerationAnnouncer', () => {
  it('is a polite, atomic, off-screen live region', () => {
    render(<GenerationAnnouncer state="idle" />);
    const el = region();
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(el.className).toContain('sr-only');
    // Idle says nothing.
    expect(el.textContent).toBe('');
  });

  it('announces the start, then the outcome — not the tokens between', () => {
    const { rerender } = render(<GenerationAnnouncer state="pending" />);
    expect(region().textContent).toBe('Assistant is responding.');

    // Streaming is the same phase as pending: the message must not change as
    // tokens arrive, or the region would talk over itself.
    rerender(<GenerationAnnouncer state="streaming" />);
    expect(region().textContent).toBe('Assistant is responding.');

    rerender(<GenerationAnnouncer state="completed" />);
    expect(region().textContent).toBe('Response complete.');
  });

  it.each([
    ['cancelled', 'Response cancelled.'],
    ['failed', 'Response failed.'],
    ['timed_out', 'Response timed out.'],
  ] as [LiveGeneration['state'], string][])('announces %s as "%s"', (state, text) => {
    const { rerender } = render(<GenerationAnnouncer state="streaming" />);
    rerender(<GenerationAnnouncer state={state} />);
    expect(region().textContent).toBe(text);
  });

  it('never holds focus — it is not focusable', () => {
    render(<GenerationAnnouncer state="streaming" />);
    // A live region announces without being reached by Tab; it has no tabindex
    // and is not an interactive element.
    expect(region().getAttribute('tabindex')).toBeNull();
  });
});
