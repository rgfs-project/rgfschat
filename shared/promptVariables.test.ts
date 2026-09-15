import { describe, expect, it } from 'vitest';
import {
  applyPromptVariables,
  isValidTimeZone,
  resolvePromptVariables,
  type PromptContext,
} from './promptVariables.ts';

/**
 * The placeholders an administrator may put in a system prompt.
 *
 * Two properties carry the weight here. Unknown braces must survive untouched —
 * a system prompt is prose somebody wrote, and quietly deleting part of it is
 * worse than leaving a literal token visible, because nobody would notice. And
 * the substitution must not feed itself: the user name is user-controlled, so a
 * second pass over the result would be an injection point.
 */

const AT: PromptContext = {
  userName: 'ada',
  // A Monday, 14:30 UTC.
  now: new Date('2026-09-14T14:30:00Z'),
  timeZone: 'UTC',
};

describe('applyPromptVariables', () => {
  it('fills the clock and the name', () => {
    const out = applyPromptVariables(
      'Today is {{CURRENT_WEEKDAY}}. You are talking to {{USER_NAME}}.',
      AT
    );

    expect(out).toBe('Today is Monday. You are talking to ada.');
  });

  it('reports the zone it was given', () => {
    expect(applyPromptVariables('{{CURRENT_TIMEZONE}}', { ...AT, timeZone: 'Europe/London' })).toBe(
      'Europe/London'
    );
  });

  /* The reader's clock, not the server's — the whole reason the zone travels
     with the request. */
  it('reads the same instant differently in two zones', () => {
    const london = applyPromptVariables('{{CURRENT_DATETIME}}', {
      ...AT,
      timeZone: 'Europe/London',
    });
    const tokyo = applyPromptVariables('{{CURRENT_DATETIME}}', { ...AT, timeZone: 'Asia/Tokyo' });

    expect(london).not.toBe(tokyo);
  });

  it('can cross a day boundary between zones', () => {
    const context = { ...AT, now: new Date('2026-09-14T23:30:00Z') };

    expect(applyPromptVariables('{{CURRENT_WEEKDAY}}', { ...context, timeZone: 'UTC' })).toBe(
      'Monday'
    );
    expect(
      applyPromptVariables('{{CURRENT_WEEKDAY}}', { ...context, timeZone: 'Asia/Tokyo' })
    ).toBe('Tuesday');
  });

  it('leaves an unknown placeholder exactly as written', () => {
    const out = applyPromptVariables('Answer as {{PERSONA}} on {{CURRENT_WEEKDAY}}.', AT);

    expect(out).toBe('Answer as {{PERSONA}} on Monday.');
  });

  it('leaves prose with braces alone', () => {
    const text = 'Use {{DOUBLE_BRACES}} for templating, e.g. {{ spaced }} or {{lower_case}}.';

    expect(applyPromptVariables(text, AT)).toBe(text);
  });

  it('is case sensitive, so a lowercase spelling is not a placeholder', () => {
    expect(applyPromptVariables('{{user_name}}', AT)).toBe('{{user_name}}');
  });

  /*
   * The name comes from an account, so it is attacker-influenced in a
   * multi-user instance. A replacement must never be rescanned.
   */
  it('does not substitute inside what it just substituted', () => {
    const out = applyPromptVariables('{{USER_NAME}}', {
      ...AT,
      userName: '{{CURRENT_DATETIME}}',
    });

    expect(out).toBe('{{CURRENT_DATETIME}}');
  });

  it('fills every occurrence, not just the first', () => {
    expect(applyPromptVariables('{{USER_NAME}} and {{USER_NAME}}', AT)).toBe('ada and ada');
  });

  it('returns a template with no placeholders untouched', () => {
    expect(applyPromptVariables('Be concise.', AT)).toBe('Be concise.');
  });

  it('handles an empty name without leaving the token behind', () => {
    expect(applyPromptVariables('[{{USER_NAME}}]', { ...AT, userName: '' })).toBe('[]');
  });

  /* A browser can report a zone this runtime has never heard of, and a
     generation must not fail over a cosmetic detail. */
  it('falls back to UTC for an unusable zone', () => {
    const out = resolvePromptVariables({ ...AT, timeZone: 'Mars/Olympus_Mons' });

    expect(out.CURRENT_TIMEZONE).toBe('UTC');
  });

  it('falls back to UTC when no zone was sent at all', () => {
    expect(resolvePromptVariables({ ...AT, timeZone: '' }).CURRENT_TIMEZONE).toBe('UTC');
  });
});

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Europe/London', 'Asia/Tokyo', 'America/New_York'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['nonsense', 'Mars/Olympus_Mons'],
    ['overlong', `Europe/${'x'.repeat(100)}`],
  ])('refuses %s', (_label, zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});
