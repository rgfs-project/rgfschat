/**
 * URL scheme filtering for rendered Markdown (INV-22).
 *
 * Lives in its own module rather than beside the renderer so that the
 * component file exports only components — a mixed module breaks React Fast
 * Refresh, which silently falls back to a full reload on every edit.
 */

/** Schemes a link or image may use. Everything else is dropped. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Returns the URL if it is safe to navigate to, else `undefined`.
 *
 * Relative URLs are allowed — they cannot execute script. Anything with an
 * explicit scheme must be on the allow-list, which excludes `javascript:`,
 * `data:`, `vbscript:`, and `file:`.
 */
export function safeUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;

  // Control characters and whitespace are stripped first: `java\nscript:` and
  // `java\tscript:` are both parsed as `javascript:` by browsers.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const cleaned = raw.replace(/[\u0000-\u0020]/g, '');

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned)) {
    // No scheme: a relative or fragment URL, which is inert.
    return raw;
  }

  try {
    return SAFE_PROTOCOLS.has(new URL(cleaned).protocol) ? raw : undefined;
  } catch {
    return undefined;
  }
}
