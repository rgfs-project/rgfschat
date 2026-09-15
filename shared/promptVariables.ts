/**
 * Placeholders an administrator may put in a model's system prompt.
 *
 * A model has no clock and no idea who it is talking to. Both are things it is
 * asked about constantly — "what day is it", "what should I call you" — and
 * both are known to the server at the moment a message is sent. These fill that
 * gap without the model having to ask for anything.
 *
 * Substitution happens per generation rather than when the prompt is saved: the
 * point of a clock is that it moves, and a datetime frozen at the moment an
 * administrator clicked Save would be wrong by the second message.
 */

export const PROMPT_VARIABLES = [
  'CURRENT_WEEKDAY',
  'CURRENT_DATETIME',
  'CURRENT_TIMEZONE',
  'USER_NAME',
] as const;

export type PromptVariable = (typeof PROMPT_VARIABLES)[number];

export interface PromptContext {
  /** The signed-in user's name, as they would see it in the interface. */
  userName: string;
  /** When the message was sent. */
  now: Date;
  /**
   * The reader's IANA zone, e.g. `Europe/London`.
   *
   * The reader's, not the server's. A self-hosted instance is very often in a
   * different place from the person using it, and a model told it is 3am when
   * its user is having breakfast answers accordingly.
   */
  timeZone: string;
}

/**
 * `Intl` throws on a zone it does not recognise, and the zone arrives from a
 * browser — so it is checked once here rather than at each of the three places
 * that format with it.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === '' || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function format(now: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(now);
}

/** What each placeholder resolves to. Exported so a UI can show a preview. */
export function resolvePromptVariables(context: PromptContext): Record<PromptVariable, string> {
  // A zone the browser made up would throw inside `Intl`, which would fail the
  // generation over a cosmetic detail. UTC is the honest fallback.
  const zone = isValidTimeZone(context.timeZone) ? context.timeZone : 'UTC';

  return {
    CURRENT_WEEKDAY: format(context.now, zone, { weekday: 'long' }),
    CURRENT_DATETIME: format(context.now, zone, {
      dateStyle: 'long',
      timeStyle: 'short',
    }),
    CURRENT_TIMEZONE: zone,
    USER_NAME: context.userName,
  };
}

/**
 * Fills the known placeholders in a template, leaving every other one alone.
 *
 * Unknown braces are returned untouched rather than blanked. A system prompt is
 * prose an administrator wrote, and it may legitimately contain `{{…}}` meant
 * for a human reader or for the model itself — silently deleting it would be a
 * worse failure than leaving a literal placeholder visible, because nobody
 * would know it had happened.
 *
 * One pass, with a replacer function: replacements are not rescanned, so a user
 * whose name happens to read `{{CURRENT_DATETIME}}` cannot inject a second
 * round of substitution.
 */
export function applyPromptVariables(template: string, context: PromptContext): string {
  const values = resolvePromptVariables(context);

  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? values[name as PromptVariable] : match
  );
}
