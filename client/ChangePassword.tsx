import { useState } from 'react';
import { createPortal } from 'react-dom';
import { changePassword } from './api.ts';

/**
 * Changing your own password.
 *
 * Lived inside `Root` behind a `hidden` container, which meant the feature
 * existed but nothing could reach it. Moved out and given a way in from the
 * account row, and portalled like every other overlay so it cannot be clipped.
 */

export function ChangePassword({ onClose }: { onClose: () => void }): React.JSX.Element {
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

  return createPortal(
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
    </div>,
    document.body
  );
}
