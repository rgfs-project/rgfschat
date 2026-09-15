const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/**
 * "Just now" / "5 minutes ago" / "3 days ago" — coarse enough that it does not
 * need to keep ticking, since nobody rereads a transcript closely enough to
 * notice a message that is "4 minutes ago" instead of "5".
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const deltaMs = then - now;
  const abs = Math.abs(deltaMs);

  if (abs < MINUTE) return 'Just now';
  if (abs < HOUR) return rtf.format(Math.round(deltaMs / MINUTE), 'minute');
  if (abs < DAY) return rtf.format(Math.round(deltaMs / HOUR), 'hour');
  if (abs < WEEK) return rtf.format(Math.round(deltaMs / DAY), 'day');
  if (abs < 4 * WEEK) return rtf.format(Math.round(deltaMs / WEEK), 'week');

  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
