import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * INV-14: identity comes only from server-side state.
 *
 * This is a *code* check rather than a behavioural one, because the failure it
 * guards against is a future route quietly reading a user id from the request —
 * which no existing test would notice. Contracts §1 and the Phase 4 prompt both
 * call for exactly this.
 */

const ROUTES_DIR = new URL('../routes/', import.meta.url).pathname;

/**
 * Patterns that would mean a route trusted the client for identity.
 *
 * `req.auth` is deliberately absent: it is populated by the session middleware
 * from the cookie, not by anything the client can set.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /req\.(?:body|params|query)[^\n]*\buserId\b/, why: 'user id taken from the request' },
  {
    pattern: /req\.(?:body|params|query)[^\n]*\bownerId\b/,
    why: 'owner id taken from the request',
  },
  { pattern: /req\.get\(\s*['"]x-user/i, why: 'identity taken from a header' },
  { pattern: /headers\[\s*['"]x-user/i, why: 'identity taken from a header' },
  { pattern: /req\.headers\.[a-z]*user/i, why: 'identity taken from a header' },
];

async function routeFiles(): Promise<string[]> {
  const entries = await readdir(ROUTES_DIR);
  return entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
}

describe('INV-14: no route reads identity from the request', () => {
  it('finds route files to check', async () => {
    // Guards against the check silently passing because it scanned nothing.
    expect((await routeFiles()).length).toBeGreaterThan(2);
  });

  it('no route file takes a user id from the body, params, query, or a header', async () => {
    const offences: string[] = [];

    for (const name of await routeFiles()) {
      const source = await readFile(join(ROUTES_DIR, name), 'utf8');

      for (const { pattern, why } of FORBIDDEN) {
        const match = pattern.exec(source);
        if (match !== null) offences.push(`${name}: ${why} — ${match[0].trim()}`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('every route that needs an owner derives it from req.auth', async () => {
    for (const name of await routeFiles()) {
      const source = await readFile(join(ROUTES_DIR, name), 'utf8');
      if (!source.includes('ownerOf(')) continue;

      // The single helper each router uses must read only from req.auth.
      const helper = /function ownerOf\(req[^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
      expect(helper, `${name} defines ownerOf`).not.toBeNull();
      expect(helper?.[1]).toContain('req.auth');
      expect(helper?.[1]).not.toMatch(/req\.(body|params|query|headers)/);
    }
  });

  it('the pattern list actually matches a violation', () => {
    // A code check that cannot fail is worthless; prove it catches the thing.
    const sample = 'const user = req.body.userId;';
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(true);
  });
});
