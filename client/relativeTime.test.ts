import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime.ts';

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-15T12:00:00.000Z').getTime();
  const ago = (ms: number): string => new Date(now - ms).toISOString();

  it('collapses anything under a minute to "Just now"', () => {
    expect(formatRelativeTime(ago(0), now)).toBe('Just now');
    expect(formatRelativeTime(ago(45_000), now)).toBe('Just now');
  });

  it('reports whole minutes under an hour', () => {
    expect(formatRelativeTime(ago(5 * 60_000), now)).toBe('5 minutes ago');
  });

  it('reports whole hours under a day', () => {
    expect(formatRelativeTime(ago(4 * 3_600_000), now)).toBe('4 hours ago');
  });

  it('reports whole days under a week', () => {
    expect(formatRelativeTime(ago(3 * 86_400_000), now)).toBe('3 days ago');
  });

  it('reports whole weeks under a month', () => {
    expect(formatRelativeTime(ago(2 * 7 * 86_400_000), now)).toBe('2 weeks ago');
  });

  it('falls back to a calendar date past a month', () => {
    expect(formatRelativeTime(ago(90 * 86_400_000), now)).toBe(
      new Date(now - 90 * 86_400_000).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    );
  });

  it('is blank for an unparsable timestamp rather than "Invalid Date"', () => {
    expect(formatRelativeTime('not a date', now)).toBe('');
  });
});
