import { useState } from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import type { UserDto } from '@shared/auth.ts';
import { ApiError, login, register, setCsrfToken } from './api.ts';

export interface SignInProps {
  /** Registration is only offered when the server says it is open. */
  registrationOpen: boolean;
  onSignedIn: (user: UserDto) => void;
}

export function SignIn({ registrationOpen, onSignedIn }: SignInProps): React.JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const registering = mode === 'register' && registrationOpen;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = registering
        ? await register(username.trim(), password)
        : await login(username.trim(), password);

      setCsrfToken(result.csrfToken);
      setPassword('');
      onSignedIn(result.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form className="signin__card" onSubmit={(e) => void submit(e)}>
        <h1>Workspace</h1>
        <p className="muted small">{registering ? 'Create an account.' : 'Sign in to continue.'}</p>

        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
          />
        </label>

        <button type="submit" disabled={busy || username.trim() === '' || password === ''}>
          {registering ? <UserPlus size={16} /> : <LogIn size={16} />}
          {registering ? 'Create account' : 'Sign in'}
        </button>

        {registrationOpen && (
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setMode(registering ? 'login' : 'register');
              setError(null);
            }}
          >
            {registering ? 'I already have an account' : 'Create an account instead'}
          </button>
        )}
      </form>
    </main>
  );
}
