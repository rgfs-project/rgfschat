import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  type SessionDto,
} from '@shared/auth.ts';
import type { AuthConfig } from '../config.ts';
import { AppError } from '../errors/AppError.ts';
import { addressOf, rateLimit, userOf, type RateLimiter } from '../middleware/rateLimit.ts';
import { validateBody } from '../http/validate.ts';
import type { Logger } from '../logger.ts';
import { requireAuth, requireSameOrigin } from '../auth/middleware.ts';
import { SESSION_COOKIE, type SessionManager } from '../auth/sessions.ts';
import { toDto, type UserStore } from '../auth/users.ts';

const credentialsSchema = z.strictObject({
  username: z.string().min(USERNAME_MIN_LENGTH).max(USERNAME_MAX_LENGTH),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export interface AuthRoutesOptions {
  users: UserStore;
  sessions: SessionManager;
  /** Shared with every other limited route, so one process has one budget. */
  limiter: RateLimiter;
  config: AuthConfig;
  isProduction: boolean;
  logger: Logger;
  /**
   * Resolved per request, not captured at boot.
   *
   * From Phase 9 an administrator can change the registration mode at runtime,
   * and a value read once at startup would keep the old answer until a restart
   * — which is exactly the situation an operator is trying to fix when they
   * close registration.
   */
  registrationMode?: () => 'open' | 'closed';
}

export function authRouter({
  users,
  sessions,
  config,
  isProduction,
  logger,
  limiter,
  registrationMode = () => config.registrationMode,
}: AuthRoutesOptions): Router {
  const router = Router();

  /*
   * Both dimensions, because either alone leaves a hole: per address lets a
   * botnet spread one account's guesses across many hosts, and per username
   * lets one host work through a list of accounts. A caller must stay under
   * both.
   *
   * The username is lowercased for the key because usernames are
   * case-insensitive (contracts §6) — otherwise `Root` and `root` would be two
   * budgets for one account.
   */
  const perAddress = (name: string, limit: number): RequestHandler =>
    rateLimit(limiter, { name, limit, windowMs: 15 * 60_000, key: addressOf });

  const perUsername = (name: string, limit: number): RequestHandler =>
    rateLimit(limiter, {
      name,
      limit,
      windowMs: 15 * 60_000,
      key: (req) => {
        const body = req.body as { username?: unknown };
        return typeof body?.username === 'string' ? body.username.toLowerCase() : null;
      },
    });

  const setSessionCookie = (res: Response, token: string): void => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
    });
  };

  /** Public: how the client learns whether it is signed in, and its CSRF token. */
  router.get('/auth/session', (req, res) => {
    const dto: SessionDto = {
      user:
        req.auth === undefined
          ? null
          : toDto({
              id: req.auth.userId,
              username: req.auth.username,
              role: req.auth.role,
              status: 'active',
              createdAt: '',
            }),
      csrfToken: req.auth?.csrfToken ?? null,
      registrationOpen: registrationMode() === 'open',
    };
    res.json(dto);
  });

  router.post(
    '/auth/register',
    requireSameOrigin(),
    validateBody(credentialsSchema),
    perAddress('register-address', 10),
    perUsername('register-username', 5),
    async (req, res) => {
      if (registrationMode() !== 'open') {
        throw new AppError('REGISTRATION_CLOSED', 'Registration is closed.');
      }

      const { username, password } = req.body as z.infer<typeof credentialsSchema>;
      const user = await users.create({ username, password });

      const session = await sessions.create(user.id);
      setSessionCookie(res, session.token);

      res.status(201).json({ user, csrfToken: session.csrfToken });
    }
  );

  router.post(
    '/auth/login',
    requireSameOrigin(),
    validateBody(credentialsSchema),
    perAddress('login-address', 20),
    perUsername('login-username', 10),
    async (req, res) => {
      const { username, password } = req.body as z.infer<typeof credentialsSchema>;

      const record = await users.verify(username, password);
      // A disabled account is rejected exactly like a wrong password, so the
      // response never distinguishes "wrong" from "suspended".
      if (record === null || record.status !== 'active') {
        logger.warn('Failed sign-in attempt', {});
        throw new AppError('UNAUTHENTICATED', 'Incorrect username or password.');
      }

      // Fresh token on every login defeats session fixation (contracts §6).
      const existing = req.auth?.token;
      if (existing !== undefined) await sessions.destroy(existing);

      const session = await sessions.create(record.id);
      setSessionCookie(res, session.token);

      res.json({ user: toDto(record), csrfToken: session.csrfToken });
    }
  );

  router.post('/auth/logout', requireAuth(), async (req, res) => {
    // Server-side destruction, not merely a cleared cookie: a copied token
    // must stop working too.
    await sessions.destroy(req.auth!.token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.post(
    '/auth/password',
    requireAuth(),
    validateBody(changePasswordSchema),
    // Per account: this route verifies the current password, so it is a
    // guessing oracle for anyone who has stolen a session but not the password.
    rateLimit(limiter, {
      name: 'password-change',
      limit: 10,
      windowMs: 15 * 60_000,
      key: userOf,
    }),
    async (req, res) => {
      const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
      const auth = req.auth!;

      if ((await users.verify(auth.username, currentPassword)) === null) {
        throw new AppError('UNAUTHENTICATED', 'Your current password is incorrect.');
      }

      await users.setPassword(auth.userId, newPassword);

      // Every other session is revoked: a password change must evict whoever
      // was using the old one (contracts §6).
      await sessions.revokeAllForUser(auth.userId, { except: auth.token });

      res.status(204).end();
    }
  );

  return router;
}
