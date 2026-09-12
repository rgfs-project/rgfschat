import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors/AppError.ts';

/**
 * Per-process rate limiting.
 *
 * **Per process, and that is a real limitation.** Contracts §2 already says
 * this application is single-process and that multi-host deployment is
 * unsupported, so a shared store would be solving a problem this deployment
 * does not have — but anyone who puts two of these behind a load balancer gets
 * twice the limit, and that is documented rather than implied.
 *
 * A fixed window, not a token bucket. The thing being defended against is
 * someone trying thousands of passwords or uploading in a loop, and a window
 * stops that just as well while being something a person can reason about from
 * the `Retry-After` they are given. The cost is that a caller can spend a
 * whole window's budget at its very end and another at the start of the next;
 * for these limits, that is not worth a more complex counter.
 */

export interface RateLimitRule {
  /** How many requests are allowed in one window. */
  limit: number;
  windowMs: number;
  /**
   * What is being counted, as a stable string, or `null` to skip counting.
   *
   * Returning `null` is how a rule declines to apply — an authenticated route
   * limiting per user has nothing to count before sign-in, and counting those
   * under one key would let any one caller lock out everybody.
   */
  key: (req: Request) => string | null;
  /** Named in logs and in the error, so a 429 says which limit was reached. */
  name: string;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * The counters, with their own sweep.
 *
 * A plain `Map` grows without bound as keys go out of use — one entry per IP
 * that ever tried to sign in — so expired windows are dropped on write. The
 * sweep is amortised across requests rather than run on a timer: a timer would
 * keep the process awake and would run just as often when nothing is happening.
 */
export class RateLimiter {
  readonly #windows = new Map<string, Window>();
  /** Swept at most this often, however many requests arrive between. */
  static readonly #SWEEP_INTERVAL_MS = 60_000;
  #sweptAt = 0;

  /**
   * Counts one request against `key`.
   *
   * Returns how long to wait when the limit is reached, or `null` when the
   * request may proceed.
   */
  hit(key: string, rule: RateLimitRule, now = Date.now()): number | null {
    this.#sweep(now);

    const existing = this.#windows.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return null;
    }

    existing.count += 1;
    if (existing.count <= rule.limit) return null;

    return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  }

  /** Forgets a key, so a success can clear the failures that preceded it. */
  forget(key: string): void {
    this.#windows.delete(key);
  }

  #sweep(now: number): void {
    if (now - this.#sweptAt < RateLimiter.#SWEEP_INTERVAL_MS) return;
    this.#sweptAt = now;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }

  /** Diagnostic aid: how many windows are currently tracked. */
  get size(): number {
    return this.#windows.size;
  }
}

/**
 * The caller's address, for limits that must apply before anyone is known.
 *
 * `req.ip` honours `trust proxy`, which is off by default — so behind a
 * reverse proxy every request appears to come from the proxy and the limit
 * becomes global. That is the safe direction to be wrong in (too strict, not
 * too lax) and is documented in SECURITY.md; turning `trust proxy` on without
 * knowing the hop count would let a caller spoof `X-Forwarded-For` and bypass
 * the limit entirely, which is the unsafe direction.
 */
export function addressOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** The signed-in user, or `null` before sign-in. */
export function userOf(req: Request): string | null {
  return req.auth?.userId ?? null;
}

function reject(res: Response, retryAfterSeconds: number, rule: RateLimitRule): never {
  // RFC 9110: the client is told when to come back, rather than being left to
  // guess and retry into the same wall.
  res.setHeader('Retry-After', String(retryAfterSeconds));

  throw new AppError('RATE_LIMITED', 'Too many requests. Please wait and try again.', {
    details: { retryAfterSeconds, limit: rule.name },
  });
}

/**
 * Applies one rule.
 *
 * Several can be stacked on a route — login counts per address *and* per
 * username, because either alone leaves a hole: per address lets a botnet
 * spread one username's guesses across many hosts, and per username lets one
 * host work through a list of accounts.
 */
export function rateLimit(limiter: RateLimiter, rule: RateLimitRule): RequestHandler {
  return (req, res, next) => {
    const key = rule.key(req);
    if (key === null) {
      next();
      return;
    }

    const retryAfter = limiter.hit(`${rule.name}:${key}`, rule);
    if (retryAfter === null) {
      next();
      return;
    }

    try {
      reject(res, retryAfter, rule);
    } catch (error) {
      next(error);
    }
  };
}
