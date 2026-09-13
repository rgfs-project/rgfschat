/**
 * "4 minutes ago" for a stored timestamp.
 *
 * Its own module rather than a helper inside `Message.tsx`: a component file
 * that also exports a plain function breaks React Fast Refresh, which then
 * falls back to a full reload on every edit.
 */

/**
 * The ladder, coarsest first: the coarsest unit a message is at least one of
 * is the one it is named in. Each rung is that unit's length in seconds, which
 * is both the threshold to reach it and the divisor once it is reached.
 *
 * Months and years are the average Gregorian length, not 30 and 365 days, so
 * the count does not drift against the calendar: twelve 30-day months fall
 * five days short of a year, which is five days in which a message is a year
 * old and the ladder still has a month to go.
 */
const RUNGS: [seconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [31_556_952, 'year'],
  [2_629_746, 'month'],
  [604_800, 'week'],
  [86_400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
];

/**
 * Below a minute, no unit is worth naming. "43 seconds ago" says less than
 * "just now" about a message the reader has been watching arrive, and it is
 * the one value on the ladder that is stale by the time it is read.
 */
const JUST_NOW_SECONDS = 60;

/**
 * `numeric: 'always'`, so a day-old message reads "1 day ago" rather than
 * "yesterday". A row of these is scanned rather than read, and numbers line up
 * in a way that a mix of words and numbers does not.
 */
const FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });

/**
 * Formats `iso` as a relative time against `now`.
 *
 * Returns `undefined` for anything unparseable so the caller can leave the slot
 * empty: a message with a broken timestamp is better shown with no time than
 * with "Invalid Date ago".
 */
export function relativeTime(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (iso === undefined) return undefined;

  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;

  const elapsed = (now.getTime() - at) / 1000;

  // A clock that disagrees with the server's, or a file edited by hand, can put
  // a message in the future. "In 3 minutes" for something already on screen
  // reads as a bug, so anything not yet past is treated as having just arrived.
  if (elapsed < JUST_NOW_SECONDS) return 'just now';

  for (const [seconds, unit] of RUNGS) {
    if (elapsed < seconds) continue;
    // Floor, not round. A timestamp should never claim more time has passed
    // than has: rounding puts "4 days ago" on a message sent three and a half
    // days back, and "1 year ago" on one from eleven months.
    return FORMATTER.format(-Math.floor(elapsed / seconds), unit);
  }

  // Unreachable: the finest rung is a minute and everything under one is
  // "just now". Kept so the function has a total return type rather than one
  // that depends on the ladder's contents.
  return 'just now';
}

/**
 * The full local time, for the `title` and for assistive technology.
 *
 * The relative form is the one worth reading at a glance; the exact one is what
 * you want when the glance raises a question.
 */
export function exactTime(iso: string): string | undefined {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return new Date(at).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}
