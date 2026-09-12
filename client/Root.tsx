import { useCallback, useEffect, useMemo, useState } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import type { AuthState, UserDto } from '@shared/auth.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { logout, onAuthExpired, setCsrfToken } from './api.ts';
import { createQueryClient, keys, useConversations, useModels, useSession } from './queries.ts';
import { AppRoutes } from './routes/AppRoutes.tsx';
import { SessionContext, type SessionValue } from './routes/session.ts';

/**
 * The application shell.
 *
 * Three things live here rather than inside a route, and all three are
 * deliberate:
 *
 *  1. **The cold start is concurrent.** Session, conversation list and models
 *     are all started on the first render instead of the latter two waiting to
 *     be mounted by an authenticated route. Previously the shell rendered
 *     nothing until the session resolved, which made first paint three round
 *     trips deep for no reason — none of the three depends on another's
 *     *result*, only on the user turning out to be signed in, and that can be
 *     settled after the fact by discarding what was fetched.
 *
 *  2. **The shell never unmounts.** It sits above the router, so nothing a
 *     route does can destroy it.
 *
 *  3. **The draft outlives the route.** A session expiring mid-sentence sends
 *     the reader to `/login`, which unmounts the chat screen; holding the
 *     composer's text here is what returns it to them afterwards. The
 *     conversation they were in needs no such help any more — it is in the URL,
 *     and `RequireAuth` hands that URL back after they sign in.
 */
export function Root(): React.JSX.Element {
  return (
    <BrowserRouter>
      <AppRoot />
    </BrowserRouter>
  );
}

/**
 * Everything below the router.
 *
 * Separate from `Root` so a test can supply its own router. `BrowserRouter`
 * reads the real `window.history`, which in jsdom is one object shared by every
 * test in a file — so a test that navigated to a conversation left the next one
 * starting there, and assertions about a fresh application quietly ran against
 * the previous test's screen. A `MemoryRouter` per test has no such thread
 * between them.
 */
export function AppRoot(): React.JSX.Element {
  // One client for the lifetime of the app; a new one per render would discard
  // the cache on every state change.
  const [client] = useState(createQueryClient);

  return (
    <QueryClientProvider client={client}>
      <ErrorBoundary region="application">
        <Shell />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

function Shell(): React.JSX.Element {
  const session = useSession();
  const [expired, setExpired] = useState(false);

  /** Survives the sign-in round trip; see the note on this component. */
  const [draft, setDraft] = useState('');

  /*
   * Any request may be the one that discovers the session has gone. The
   * transition is made once, here, rather than by whichever call site happened
   * to notice.
   */
  useEffect(() => onAuthExpired(() => setExpired(true)), []);

  const authState: AuthState = expired
    ? 'unauthenticated'
    : session.isPending
      ? 'unknown'
      : (session.data?.user ?? null) !== null
        ? 'authenticated'
        : 'unauthenticated';

  /*
   * Started now, not after auth resolves. While the session is `unknown` these
   * are allowed to race it; if it comes back unauthenticated they are discarded
   * below and their results never reach the screen.
   */
  const allowed = authState !== 'unauthenticated';
  useConversations(allowed);
  useModels(allowed);

  /*
   * Whatever those two fetched for a user who turns out not to be signed in is
   * dropped. They were started on speculation; once the speculation is wrong,
   * keeping the results would mean one user's list could be shown to the next.
   */
  const client = useQueryClient();
  useEffect(() => {
    if (authState !== 'unauthenticated') return;
    client.removeQueries({ queryKey: keys.conversations() });
    client.removeQueries({ queryKey: ['conversation'] });
    client.removeQueries({ queryKey: keys.models() });
  }, [authState, client]);

  const csrfToken = session.data?.csrfToken ?? null;
  useEffect(() => {
    if (csrfToken !== null) setCsrfToken(csrfToken);
  }, [csrfToken]);

  const onSignedIn = useCallback(
    (_user: UserDto) => {
      setExpired(false);
      // The session is the authority on who is signed in; refetching it also
      // picks up the new CSRF token rather than trusting a second copy.
      void session.refetch();
    },
    [session]
  );

  const onSignOut = useCallback(() => {
    void (async () => {
      await logout();
      setCsrfToken(null);
      setDraft('');
      setExpired(true);
    })();
  }, []);

  /*
   * Memoised because it is a context value: a fresh object each render would
   * re-render every screen reading it, on every keystroke in the composer.
   */
  const value = useMemo<SessionValue>(
    () => ({
      authState,
      user: session.data?.user ?? null,
      registrationOpen: session.data?.registrationOpen ?? false,
      expired,
      onSignedIn,
      onSignOut,
    }),
    [authState, session.data, expired, onSignedIn, onSignOut]
  );

  return (
    <SessionContext value={value}>
      <AppRoutes draft={draft} onDraftChange={setDraft} />
    </SessionContext>
  );
}
