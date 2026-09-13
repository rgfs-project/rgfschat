/**
 * Why a generation failed, in words.
 *
 * Its own module because two places need the same sentence: the banner shown
 * the moment a run fails, and the transcript when that reply is read back
 * tomorrow. Two copies would drift, and the second one is the one nobody
 * checks.
 *
 * The server classifies every failure and logs it. The person looking at the
 * transcript is generally not the person who can read that log, and the
 * difference between a provider that is down, a request too big for the model,
 * and a reply that died halfway is the difference between waiting, shortening,
 * and simply trying again.
 */
export function failureMessage(code: string | undefined): string {
  switch (code) {
    case 'PROVIDER_UNAVAILABLE':
      return 'The model provider is unreachable. It may be down or still loading.';
    case 'PROVIDER_TIMEOUT':
      return 'The model provider timed out.';
    case 'MODEL_NOT_FOUND':
      return 'That model is no longer available from this provider.';
    case 'CONTEXT_TOO_LARGE':
      return 'This conversation is too long for the model. Start a new one, or remove an attachment.';
    case 'PROVIDER_ERROR':
      return 'The model provider rejected the request or failed part-way through the reply.';
    case 'INTERNAL':
      return 'The generation failed inside this server. Check the server logs.';
    default:
      // An unrecognised code is one this interface genuinely has nothing to
      // say about, so it points at the place that does.
      return 'The generation failed. Check the server logs.';
  }
}
