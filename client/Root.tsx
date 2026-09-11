import { useCallback, useEffect, useState } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { AuthState, UserDto } from '@shared/auth.ts';
import { App } from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SignIn } from './SignIn.tsx';
import { logout, onAuthExpired, setCsrfToken } from './api.ts';
import { createQueryClient, keys, useConversations, useModels, useSession } from './queries.ts';

/**
 * The application shell.
 *
 * Two things live here rather than inside `App`, and both are deliberate:
 *
 *  1. **The cold start is concurrent.** Session, conversation list and models
 *     are all started on the first render instead of the latter two waiting to
 *     be mounted by an authenticated `App`. Previously the shell rendered
 *     nothing until the session resolved, which made first paint three round
 *     trips deep for no reason — none of the three depends on another's
 *     *result*, only on the user turning out to be signed in, and that can be
 *     settled after the fact by discarding what was fetched.
 *
 *  2. **The shell never unmounts.** The composer draft and the open
 *     conversation are held here, so a session expiring mid-sentence and the
 *     user signing back in returns them to the same conversation with their
 *     unsent text intact. Held inside `App` they would be destroyed by the very
 *     transition they need to survive.
 */
export function Root(): React.JSX.Element {
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
  const [currentId, setCurrentId] = useState<string | null>(null);
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

  const onSignOut = useCallback(async () => {
    await logout();
    setCsrfToken(null);
    setCurrentId(null);
    setDraft('');
    setExpired(true);
  }, []);

  if (authState === 'unknown') {
    return (
      <main className="booting">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (authState === 'unauthenticated') {
    return (
      <SignIn
        registrationOpen={session.data?.registrationOpen ?? false}
        onSignedIn={onSignedIn}
        // A session that ended mid-use is worth saying out loud; otherwise the
        // login form appears with no explanation for why.
        notice={
          expired && (session.data?.user ?? null) !== null
            ? 'Your session ended. Please sign in again.'
            : null
        }
      />
    );
  }

  const user = session.data?.user ?? null;
  if (user === null) {
    // Unreachable given authState, but narrows the type without a cast.
    return <main className="booting" />;
  }

  return (
    <App
      user={user}
      currentId={currentId}
      onSelectConversation={setCurrentId}
      draft={draft}
      onDraftChange={setDraft}
      onSignOut={() => void onSignOut()}
    />
  );
}
