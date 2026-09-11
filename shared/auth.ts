/**
 * Account and session DTOs (contracts §6).
 *
 * `passwordHash` is deliberately absent from every type here: it never leaves
 * the storage layer, so it cannot reach a response by accident (INV-03).
 */

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** What the client is allowed to know about an account. */
export interface UserDto {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export type AuthState = 'unknown' | 'authenticated' | 'unauthenticated';

/** `GET /api/auth/session` — public; describes the caller, if any. */
export interface SessionDto {
  user: UserDto | null;
  /** Required as `X-CSRF-Token` on every state-changing request. */
  csrfToken: string | null;
  /** Whether `POST /api/auth/register` will be accepted. */
  registrationOpen: boolean;
}

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
const USERNAME_RE = /^[a-z0-9_.-]+$/;

/**
 * Usernames are 3–32 characters of `[a-z0-9_.-]` and compared
 * case-insensitively, so `Ada` and `ada` are the same account.
 */
export function isValidUsername(value: string): boolean {
  return (
    value.length >= USERNAME_MIN_LENGTH &&
    value.length <= USERNAME_MAX_LENGTH &&
    USERNAME_RE.test(value)
  );
}

/** The form a username is stored and compared in. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;

export function isValidPassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
}
