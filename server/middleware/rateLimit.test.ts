import { describe, expect, it } from 'vitest';
import { RateLimiter, addressOf, rateLimit, userOf } from './rateLimit.ts';
import { AppError } from '../errors/AppError.ts';
import type { Request, Response } from 'express';

/**
 * The counter and the middleware around it.
 *
 * Time is passed in rather than mocked, so the window arithmetic is tested
 * directly and no test has to wait for a real minute to pass.
 */

const RULE = { name: 'test', limit: 3, windowMs: 1_000, key: () => 'k' };

describe('the window', () => {
  it('allows exactly the limit, then refuses', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;

    expect(limiter.hit('a', RULE, now)).toBeNull();
    expect(limiter.hit('a', RULE, now)).toBeNull();
    expect(limiter.hit('a', RULE, now)).toBeNull();

    // The fourth is the first one over.
    expect(limiter.hit('a', RULE, now)).toBeGreaterThan(0);
  });

  it('tells the caller how long to wait, in whole seconds', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < RULE.limit; i += 1) limiter.hit('a', RULE, now);

    // 400ms into a 1s window, so 600ms remain — reported as 1s, never 0.
    expect(limiter.hit('a', RULE, now + 400)).toBe(1);
  });

  it('starts a fresh window once the old one has passed', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < RULE.limit; i += 1) limiter.hit('a', RULE, now);
    expect(limiter.hit('a', RULE, now)).not.toBeNull();

    expect(limiter.hit('a', RULE, now + RULE.windowMs + 1)).toBeNull();
  });

  it('counts each key separately', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < RULE.limit; i += 1) limiter.hit('a', RULE, now);

    // One caller exhausting their budget must not spend anyone else's.
    expect(limiter.hit('b', RULE, now)).toBeNull();
  });

  it('forgets a key on request, so a success can clear failures', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < RULE.limit; i += 1) limiter.hit('a', RULE, now);

    limiter.forget('a');

    expect(limiter.hit('a', RULE, now)).toBeNull();
  });

  it('does not grow without bound as keys go out of use', () => {
    const limiter = new RateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 500; i += 1) limiter.hit(`k${i}`, RULE, now);
    expect(limiter.size).toBe(500);

    // Well past both the window and the sweep interval: the expired entries go.
    limiter.hit('fresh', RULE, now + 120_000);
    expect(limiter.size).toBe(1);
  });
});

describe('the middleware', () => {
  function run(
    limiter: RateLimiter,
    rule: Parameters<typeof rateLimit>[1],
    req: Partial<Request> = {}
  ): { error: unknown; headers: Map<string, string> } {
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
    } as unknown as Response;

    let error: unknown = null;
    rateLimit(limiter, rule)({ headers: {}, ...req } as Request, res, (err?: unknown) => {
      error = err ?? null;
    });
    return { error, headers };
  }

  it('rejects with RATE_LIMITED and a Retry-After', () => {
    const limiter = new RateLimiter();
    const rule = { name: 'r', limit: 1, windowMs: 60_000, key: () => 'one' };

    expect(run(limiter, rule).error).toBeNull();

    const { error, headers } = run(limiter, rule);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect((error as AppError).status).toBe(429);
    // Told when to come back, rather than left to retry into the same wall.
    expect(Number(headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('names the limit that was reached, without leaking anything else', () => {
    const limiter = new RateLimiter();
    const rule = { name: 'login-address', limit: 1, windowMs: 60_000, key: () => 'one' };
    run(limiter, rule);

    const { error } = run(limiter, rule);
    expect((error as AppError).details).toMatchObject({ limit: 'login-address' });
    // The message is for a person and says nothing about who or what was counted.
    expect((error as AppError).message).not.toContain('one');
  });

  it('skips counting when the rule has nothing to count', () => {
    const limiter = new RateLimiter();
    const rule = { name: 'r', limit: 1, windowMs: 60_000, key: () => null };

    // A rule that cannot identify a caller must let them through rather than
    // counting them all under one key, which would let any one lock out all.
    for (let i = 0; i < 10; i += 1) expect(run(limiter, rule).error).toBeNull();
    expect(limiter.size).toBe(0);
  });
});

describe('what is counted', () => {
  it('falls back to the socket when there is no resolved ip', () => {
    expect(addressOf({ socket: { remoteAddress: '10.0.0.1' } } as Request)).toBe('10.0.0.1');
  });

  it('never returns an empty key', () => {
    expect(addressOf({ socket: {} } as Request)).toBe('unknown');
  });

  it('reports no user before sign-in, so an anonymous rule declines', () => {
    expect(userOf({} as Request)).toBeNull();
    expect(userOf({ auth: { userId: 'u1' } } as unknown as Request)).toBe('u1');
  });
});
