import { createContext, use } from 'react';
import type { AuthState, UserDto } from '@shared/auth';

/**
 * Who is signed in, and the two things that change it.
 *
 * A context rather than props because the router sits between the component
 * that owns this state and the components that need it: every route would
 * otherwise have to be handed the same five values through a `Routes` element
 * that has no interest in any of them.
 *
 * Deliberately small. It carries identity and the transitions into and out of
 * it — nothing about conversations, which the URL now owns, and nothing about
 * the draft, which is passed explicitly to the one component that types into
 * it.
 */

export interface SessionValue {
  /** `unknown` until the session request settles; routes must not guess. */
  authState: AuthState;
  /** Non-null exactly when `authState` is `authenticated`. */
  user: UserDto | null;
  /** Whether the server is accepting new accounts, for the sign-in screen. */
  registrationOpen: boolean;
  /** A session that ended mid-use, as opposed to never having had one. */
  expired: boolean;
  onSignedIn: (user: UserDto) => void;
  onSignOut: () => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

/**
 * Throws rather than returning a default.
 *
 * A default would let a component render outside the provider with a plausible
 * "not signed in" value, which is the shape of bug that shows up as a login
 * screen in the middle of an authenticated application rather than as an error.
 */
export function useAppSession(): SessionValue {
  const value = use(SessionContext);
  if (value === null) throw new Error('useAppSession used outside SessionContext');
  return value;
}

/**
 * The signed-in user, for a screen that only exists when there is one.
 *
 * Everything below `RequireAuth` is in that position, and without this each of
 * those components would either take `UserDto | null` and carry a branch that
 * cannot happen, or assert non-null and lose the check entirely. Throwing keeps
 * the type honest: if this ever fires, a protected screen has been mounted
 * outside its guard, which is a routing bug and should be loud.
 */
export function useAuthenticatedUser(): UserDto {
  const { user } = useAppSession();
  if (user === null) throw new Error('Authenticated screen rendered without a user');
  return user;
}
