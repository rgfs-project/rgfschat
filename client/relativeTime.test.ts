import { describe, expect, it } from 'vitest';
import { exactTime, relativeTime } from './relativeTime.ts';

const NOW = new Date('2026-09-13T12:00:00.000Z');

/** `n` units before NOW, as a canonical timestamp. */
function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe('relativeTime', () => {
  it('names the coarsest unit the message is at least one of', () => {
    expect(relativeTime(ago(60), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(60 * 4), NOW)).toBe('4 minutes ago');
    expect(relativeTime(ago(3600), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(3600 * 5), NOW)).toBe('5 hours ago');
    expect(relativeTime(ago(86_400), NOW)).toBe('1 day ago');
    expect(relativeTime(ago(86_400 * 3), NOW)).toBe('3 days ago');
    expect(relativeTime(ago(604_800), NOW)).toBe('1 week ago');
    expect(relativeTime(ago(604_800 * 3), NOW)).toBe('3 weeks ago');
    expect(relativeTime(ago(2_629_746), NOW)).toBe('1 month ago');
    expect(relativeTime(ago(31_556_952), NOW)).toBe('1 year ago');
    expect(relativeTime(ago(31_556_952 * 2), NOW)).toBe('2 years ago');
  });

  it('says "just now" rather than counting seconds', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(59), NOW)).toBe('just now');
  });

  it('never claims more time has passed than has', () => {
    expect(relativeTime(ago(60 * 4 + 59), NOW)).toBe('4 minutes ago');
    expect(relativeTime(ago(86_400 * 3 + 80_000), NOW)).toBe('3 days ago');
    expect(relativeTime(ago(31_556_952 - 1), NOW)).toBe('11 months ago');
  });

  it('never reads as the future, whatever the clock says', () => {
    expect(relativeTime(new Date(NOW.getTime() + 90_000).toISOString(), NOW)).toBe('just now');
  });

  it('is undefined for a missing or unreadable timestamp', () => {
    expect(relativeTime(undefined, NOW)).toBeUndefined();
    expect(relativeTime('', NOW)).toBeUndefined();
    expect(relativeTime('the other day', NOW)).toBeUndefined();
  });

  it('keeps the month count from drifting against the calendar', () => {
    // Twelve 30-day months would have called this a year five days ago.
    expect(relativeTime(ago(86_400 * 364), NOW)).toBe('11 months ago');
    expect(relativeTime(ago(86_400 * 366), NOW)).toBe('1 year ago');
  });
});

describe('exactTime', () => {
  it('renders a readable absolute time, and nothing for a broken one', () => {
    expect(exactTime('2026-09-11T17:03:12.000Z')).toMatch(/2026/);
    expect(exactTime('not a time')).toBeUndefined();
  });
});
