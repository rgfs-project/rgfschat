import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  QueryClientProvider,
  useQueryClient,
  type Query,
  type QueryClient,
} from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import type { AuthState, UserDto } from '@shared/auth';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { logout, onAuthExpired, setCsrfToken } from './api.ts';
import { createQueryClient, useConversations, useModels, useSession } from './queries.ts';
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
export interface AppRootProps {
  client?: QueryClient;
}

export function AppRoot({ client: supplied }: AppRootProps = {}): React.JSX.Element {
  // One client for the lifetime of the app; a new one per render would discard
  // the cache on every state change. A test may hand one in, the same way it
  // hands in a router, when what it needs to assert is what the cache holds.
  const [created] = useState(createQueryClient);
  const client = supplied ?? created;

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
   * Everything cached for an account is dropped the moment the account changes.
   *
   * Two things arrive here. The speculative fetches above, started before the
   * session resolved, are discarded when the speculation turns out wrong. And a
   * sign-out — or one account signing in over another, which on a shared
   * machine happens without the page ever reloading — clears the rest.
   *
   * Named queries were tried first and got it wrong: conversations and models
   * were listed, while preferences, memories, artifacts and search results were
   * not, and no key said whose they were. The next account was handed the
   * previous one's settings straight from cache, ahead of any request of their
   * own. So the rule is inverted — everything goes except the session query,
   * which is the thing that says who is signed in now — and a query added
   * later is covered by having been added, rather than by somebody remembering
   * this list.
   *
   * Cancelled before removed: a request already in flight for the previous
   * account would otherwise land in an empty cache afterwards and put their
   * data back.
   */
  const client = useQueryClient();
  const identity = session.data?.user?.id ?? null;
  const previousIdentity = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (authState === 'unknown') return;

    const account = authState === 'authenticated' ? identity : null;
    const had = previousIdentity.current;
    previousIdentity.current = account;

    // Nothing to clear on the very first resolution *into* an account; there
    // was no previous one. Everything else — signing out, expiring, or a
    // different account arriving — clears.
    if (had === undefined && account !== null) return;
    if (had === account && account !== null) return;

    const privateQuery = { predicate: (query: Query) => query.queryKey[0] !== 'session' };
    void client.cancelQueries(privateQuery);
    client.removeQueries(privateQuery);
  }, [authState, identity, client]);

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
