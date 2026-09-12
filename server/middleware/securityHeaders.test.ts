import { describe, expect, it } from 'vitest';
import { scriptHash, securityHeaders } from './securityHeaders.ts';
import type { Request, Response } from 'express';

/**
 * The policy itself, read as a string.
 *
 * Asserted on the *directives* rather than on a whole expected header, so
 * adding a directive does not fail every test and tempt someone to paste the
 * new value in without reading it.
 */

function headersFor(
  options: { isProduction: boolean; inlineScriptHashes?: string[] },
  request: Partial<Request> = {}
): Map<string, string> {
  const set = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => set.set(name.toLowerCase(), value),
    getHeader: (name: string) => set.get(name.toLowerCase()),
  } as unknown as Response;

  let nexted = false;
  securityHeaders(options)({ headers: {}, ...request } as Request, res, () => {
    nexted = true;
  });
  expect(nexted).toBe(true);
  return set;
}

const csp = (map: Map<string, string>): string => map.get('content-security-policy') ?? '';

describe('the production policy', () => {
  const headers = headersFor({ isProduction: true, inlineScriptHashes: ['abc123'] });

  it('defaults to this origin and nothing else', () => {
    expect(csp(headers)).toContain("default-src 'self'");
  });

  it('allows no inline script, and allows the shell script by hash', () => {
    const directive = csp(headers)
      .split('; ')
      .find((part) => part.startsWith('script-src'));

    expect(directive).toContain("'sha256-abc123'");
    // The whole point: a hash is worthless beside `unsafe-inline`, because a
    // browser that sees both ignores the hash and allows everything.
    expect(directive).not.toContain('unsafe-inline');
    expect(directive).not.toContain('unsafe-eval');
  });

  it.each([
    ["object-src 'none'", 'no plugins'],
    ["frame-ancestors 'none'", 'cannot be framed'],
    ["base-uri 'self'", 'cannot be re-based'],
    ["form-action 'self'", 'cannot post elsewhere'],
  ])('sets %s (%s)', (directive) => {
    expect(csp(headers)).toContain(directive);
  });

  it('sets the other hardening headers', () => {
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});

describe('HSTS', () => {
  it('is sent in production over TLS', () => {
    const headers = headersFor({ isProduction: true }, { secure: true });
    expect(headers.get('strict-transport-security')).toContain('max-age=63072000');
  });

  it('is sent behind a proxy that terminated TLS', () => {
    const headers = headersFor(
      { isProduction: true },
      { headers: { 'x-forwarded-proto': 'https' } }
    );
    expect(headers.get('strict-transport-security')).toBeDefined();
  });

  it('is not sent over plain HTTP, which would pin a host by accident', () => {
    const headers = headersFor({ isProduction: true }, { secure: false });
    expect(headers.get('strict-transport-security')).toBeUndefined();
  });

  it('is never sent in development', () => {
    const headers = headersFor({ isProduction: false }, { secure: true });
    expect(headers.get('strict-transport-security')).toBeUndefined();
  });
});

describe('the development relaxation', () => {
  it('allows what Vite needs, and only in development', () => {
    const development = csp(headersFor({ isProduction: false }));
    expect(development).toContain('ws:');
    expect(development).toContain("'unsafe-eval'");

    // Production is not weakened for it. This is the assertion that matters:
    // the two policies are built separately rather than by subtraction.
    const production = csp(headersFor({ isProduction: true }));
    expect(production).not.toContain('ws:');
    expect(production).not.toContain("'unsafe-eval'");
  });
});

describe('an existing policy is never loosened', () => {
  it('leaves an attachment response alone', () => {
    const set = new Map<string, string>([
      ['content-security-policy', "sandbox; default-src 'none'"],
    ]);
    const res = {
      setHeader: (name: string, value: string) => set.set(name.toLowerCase(), value),
      getHeader: (name: string) => set.get(name.toLowerCase()),
    } as unknown as Response;

    securityHeaders({ isProduction: true })({ headers: {} } as Request, res, () => undefined);

    // Still the sandbox (INV-27), not the application's more permissive one.
    expect(set.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    // And the rest are still applied.
    expect(set.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('scriptHash', () => {
  it('is the base64 SHA-256 a CSP expects', () => {
    // Known vector: SHA-256 of the empty string.
    expect(scriptHash('')).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('changes when the script changes, so a stale hash fails closed', () => {
    expect(scriptHash('a')).not.toBe(scriptHash('b'));
  });
});
