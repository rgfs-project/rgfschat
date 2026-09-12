import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Security response headers, including the content security policy.
 *
 * Hand-written rather than Helmet, for the same reason there is no dotenv and
 * no cookie parser: this is a fixed, short list of headers whose values this
 * application has opinions about, and a dependency would add indirection
 * without adding judgement. Every header below is here because something
 * specific goes wrong without it, and that reason is written next to it.
 *
 * The policy is **strict in production and relaxed only for Vite** in
 * development, in a branch that cannot affect production: `isProduction` is the
 * only input, and the development additions are listed separately rather than
 * being subtractions from the production set. A policy assembled by weakening
 * is a policy that eventually ships weakened.
 */

export interface SecurityHeaderOptions {
  isProduction: boolean;
  /**
   * SHA-256 of any inline `<script>` the shell needs, base64, without the
   * `sha256-` prefix.
   *
   * `index.html` runs one inline script to apply the stored theme before the
   * first paint — without it a dark-mode reader gets a white flash on every
   * load. It cannot be moved to a file without making that paint wait on a
   * second request, and it cannot be allowed with `unsafe-inline` without
   * allowing every other inline script too. A hash allows exactly that script.
   */
  inlineScriptHashes?: readonly string[];
}

/** The hash a CSP needs for one inline script's exact bytes. */
export function scriptHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('base64');
}

function policy({ isProduction, inlineScriptHashes = [] }: SecurityHeaderOptions): string {
  const hashes = inlineScriptHashes.map((hash) => `'sha256-${hash}'`);

  const directives: Record<string, string[]> = {
    // Nothing loads from anywhere else unless a directive below says so.
    'default-src': ["'self'"],

    /*
     * No `unsafe-inline`: the one inline script is allowed by hash. Note that
     * a browser honouring a hash *ignores* `unsafe-inline` if both are present,
     * so adding the development relaxation below would silently disable the
     * hash — which is why the two sets are built separately.
     */
    'script-src': ["'self'", ...hashes],

    /*
     * `unsafe-inline` for styles only, and deliberately.
     *
     * React writes `style` attributes for things like the upload progress
     * fill, and there is no hash form that covers attribute styles. The risk
     * is bounded — a style cannot execute — and the alternative is a nonce
     * threaded through every component that sets a style, which is a large
     * change to remove a small risk.
     */
    'style-src': ["'self'", "'unsafe-inline'"],

    // Attachments are served from this origin; `data:` covers the favicon and
    // any image a Markdown reply inlines.
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'font-src': ["'self'", 'data:'],

    // The API and the SSE stream, both same-origin. Nothing else.
    'connect-src': ["'self'"],

    // No plugins, no embedding, no framing of this page by anyone.
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],

    // A stolen injection cannot post a form to an attacker's server.
    'form-action': ["'self'"],

    // Nothing may navigate the top-level page away from this origin.
    'base-uri': ["'self'"],
  };

  if (!isProduction) {
    /*
     * Vite's dev server only. It serves modules over a websocket for hot
     * reload and injects its client inline, neither of which production does.
     * Listed as additions to named directives so that reading this file makes
     * plain exactly what development is allowed that production is not.
     */
    directives['connect-src'] = ["'self'", 'ws:', 'wss:'];
    directives['script-src'] = ["'self'", "'unsafe-inline'", "'unsafe-eval'"];
  }

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export function securityHeaders(options: SecurityHeaderOptions): RequestHandler {
  const value = policy(options);

  return (req, res, next) => {
    /*
     * Attachment responses set their own, much stricter, policy — a sandbox
     * with `default-src 'none'` (INV-27). Overwriting it here with the
     * application's policy would loosen it, so those are left alone.
     */
    if (res.getHeader('Content-Security-Policy') === undefined) {
      res.setHeader('Content-Security-Policy', value);
    }

    // A stored type is never second-guessed, anywhere in the application.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Belt and braces with `frame-ancestors`, for anything that predates CSP.
    res.setHeader('X-Frame-Options', 'DENY');

    /*
     * Same-origin only, and only the origin cross-site. A conversation id in a
     * path is not something to hand to whatever a reader clicks through to.
     */
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Nothing here needs any of these; asking for none of them means a stolen
    // injection cannot ask either.
    res.setHeader(
      'Permissions-Policy',
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
    );

    // Isolates this origin's browsing context group from anything it opens.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    if (options.isProduction) {
      /*
       * Two years, subdomains included. Only in production and only over TLS:
       * sent on a plain-HTTP development server it would be ignored, and sent
       * to a browser that reached a *staging* host over HTTP it would pin that
       * host to HTTPS for two years by accident.
       */
      if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      }
    }

    next();
  };
}
