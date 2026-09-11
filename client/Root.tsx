import { useCallback, useEffect, useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import type { AuthState, UserDto } from '@shared/auth.ts';
import { App } from './App.tsx';
import { SignIn } from './SignIn.tsx';
import { changePassword, fetchSession, logout, setCsrfToken } from './api.ts';

/**
 * Decides what the application is allowed to show.
 *
 * Auth state is `unknown | authenticated | unauthenticated`, and **nothing**
 * auth-dependent renders while it is `unknown` — otherwise a signed-in user
 * sees a login form flash on every reload, and an unauthenticated one briefly
 * sees a chrome they have no right to.
 */
export function Root(): React.JSX.Element {
  const [state, setState] = useState<AuthState>('unknown');
  const [user, setUser] = useState<UserDto | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    fetchSession()
      .then((session) => {
        if (controller.signal.aborted) return;
        setCsrfToken(session.csrfToken);
        setRegistrationOpen(session.registrationOpen);
        setUser(session.user);
        setState(session.user === null ? 'unauthenticated' : 'authenticated');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('unauthenticated');
      });

    return () => controller.abort();
  }, []);

  const onSignedIn = useCallback((next: UserDto) => {
    setUser(next);
    setState('authenticated');
  }, []);

  const onSignOut = useCallback(async () => {
    await logout();
    setCsrfToken(null);
    setUser(null);
    setState('unauthenticated');
  }, []);

  if (state === 'unknown') {
    return (
      <main className="signin">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (state === 'unauthenticated' || user === null) {
    return <SignIn registrationOpen={registrationOpen} onSignedIn={onSignedIn} />;
  }

  return (
    <>
      <App user={user} onSignOut={() => void onSignOut()} />
      <div className="account" hidden>
        <span className="account__name">{user.username}</span>
        <button
          type="button"
          className="icon"
          title="Change password"
          aria-label="Change password"
          onClick={() => setChanging(true)}
        >
          <KeyRound size={14} />
        </button>
        <button
          type="button"
          className="icon"
          title="Sign out"
          aria-label="Sign out"
          onClick={() => void onSignOut()}
        >
          <LogOut size={14} />
        </button>
      </div>
      {changing && <ChangePassword onClose={() => setChanging(false)} />}
    </>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change your password.');
    }
  }

  return (
    <div className="modal" role="dialog" aria-label="Change password">
      <form className="modal__card" onSubmit={(e) => void submit(e)}>
        <h2>Change password</h2>

        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {done && (
          <p className="muted small">Password changed. Your other sessions have been signed out.</p>
        )}

        {!done && (
          <>
            <label className="field">
              <span>Current password</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
          </>
        )}

        <div className="modal__actions">
          {!done && <button type="submit">Change password</button>}
          <button type="button" className="linkish" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
        </div>
      </form>
    </div>
  );
}
