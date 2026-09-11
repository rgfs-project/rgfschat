import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors/AppError.ts';
import type { UserStore } from './users.ts';
import { SESSION_COOKIE, safeEqual, type SessionManager } from './sessions.ts';

/**
 * Authentication and CSRF (contracts §5–§6).
 *
 * Identity comes only from the session cookie, resolved server-side (INV-14).
 * No route reads a user id from a header, query, body, or route param — a test
 * greps for it so a future route cannot quietly reintroduce one.
 */

/** Attached by `authenticate`; the only identity any route may use. */
export interface AuthContext {
  userId: string;
  username: string;
  role: 'user' | 'admin';
  csrfToken: string;
  token: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** Reads a cookie without pulling in a parser dependency for one value. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export interface AuthMiddlewareOptions {
  sessions: SessionManager;
  users: UserStore;
}

/**
 * Resolves the session, if any, and attaches it.
 *
 * The user record is loaded on **every** request rather than trusted from the
 * session, so a disabled account or a role change takes effect immediately
 * (INV-17). A session for a missing or disabled user is destroyed on sight.
 */
export function authenticate({ sessions, users }: AuthMiddlewareOptions): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (token === null) return next();

        const session = await sessions.resolve(token);
        if (session === null) return next();

        const user = await users.findById(session.userId);
        if (user === null || user.status !== 'active') {
          await sessions.destroy(token);
          return next();
        }

        req.auth = {
          userId: user.id,
          username: user.username,
          role: user.role,
          csrfToken: session.csrfToken,
          token,
        };
        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

/** Rejects anything without a valid session. Mounted on every non-public route. */
export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    if (req.auth === undefined) {
      next(new AppError('UNAUTHENTICATED', 'You must sign in to do that.'));
      return;
    }
    next();
  };
}

/**
 * Gate for every administrative route (INV-24).
 *
 * The role is resolved from the stored user record on each request, never from
 * anything the client sent and never from a value cached at sign-in. That is
 * what makes a demotion take effect immediately: an admin demoted while their
 * session is open is refused on their very next request, rather than keeping
 * their powers until the session happens to expire.
 *
 * UI that hides admin controls is a convenience. This is the enforcement.
 */
export function requireAdmin({ users }: Pick<AuthMiddlewareOptions, 'users'>): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        if (req.auth === undefined) {
          next(new AppError('UNAUTHENTICATED', 'You must sign in to do that.'));
          return;
        }

        const user = await users.findById(req.auth.userId);
        // A user disabled or deleted mid-session is no longer signed in at all,
        // which is a different answer from "signed in but not permitted".
        if (user === null || user.status !== 'active') {
          next(new AppError('UNAUTHENTICATED', 'You must sign in to do that.'));
          return;
        }

        if (user.role !== 'admin') {
          next(new AppError('FORBIDDEN', 'You do not have access to that.'));
          return;
        }

        next();
      } catch (err) {
        next(err);
      }
    })();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Synchronizer-token CSRF (contracts §5, INV-16).
 *
 * Every state-changing request must present the session's token as
 * `X-CSRF-Token`. Safe methods are exempt, and SSE endpoints are GET.
 */
export function requireCsrf(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const provided = req.get('X-CSRF-Token');
    const expected = req.auth?.csrfToken;

    if (
      provided === undefined ||
      provided === '' ||
      expected === undefined ||
      !safeEqual(provided, expected)
    ) {
      next(new AppError('CSRF_INVALID', 'Missing or invalid CSRF token.'));
      return;
    }
    next();
  };
}

/**
 * Same-origin check for login and registration.
 *
 * There is no session yet, so there is no synchronizer token to present;
 * `Sec-Fetch-Site` (or a matching `Origin`) is what stands in (contracts §5).
 */
export function requireSameOrigin(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const fetchSite = req.get('Sec-Fetch-Site');
    if (fetchSite === 'same-origin' || fetchSite === 'none') {
      next();
      return;
    }

    const origin = req.get('Origin');
    if (origin !== undefined) {
      const host = req.get('Host');
      try {
        if (host !== undefined && new URL(origin).host === host) {
          next();
          return;
        }
      } catch {
        // Unparseable Origin; fall through to rejection.
      }
      next(new AppError('CSRF_INVALID', 'Cross-origin request rejected.'));
      return;
    }

    // Neither header present: a browser always sends at least one on a
    // cross-origin POST, so this is a non-browser client. Allow it so the CLI
    // and tests work; it carries no ambient cookie authority.
    if (fetchSite === undefined) {
      next();
      return;
    }

    next(new AppError('CSRF_INVALID', 'Cross-origin request rejected.'));
  };
}
