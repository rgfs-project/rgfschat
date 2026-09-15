import { Navigate, useLocation, useNavigate } from 'react-router';
import { AdminPanel } from '../AdminPanel.tsx';
import { SettingsPanel } from '../SettingsPanel.tsx';
import { paths } from './paths.ts';
import { useAuthenticatedUser } from './session.ts';

/**
 * Settings and Admin: panels that have a URL.
 *
 * They stay overlays — they open over the conversation being read and close
 * back onto it — but each is now an address, so it can be linked to, reloaded,
 * and dismissed with the Back button. That last one is the part a reader
 * notices: on a phone, Back is how anything covering the screen is expected to
 * close.
 *
 * Closing goes **back** rather than to a fixed path, so the panel behaves like
 * the overlay it looks like: it returns you where you were. A direct visit has
 * nothing to return to, so those fall forward to the draft screen instead of
 * leaving the browser on a page that is now empty behind a dismissed panel.
 */

/** Whether this location was arrived at from inside the application. */
function useCameFromInside(): boolean {
  const location = useLocation();
  const state = location.state as { background?: unknown } | null;
  return state?.background !== undefined;
}

function useDismiss(): () => void {
  const navigate = useNavigate();
  const fromInside = useCameFromInside();

  return () => {
    if (fromInside) void navigate(-1);
    else void navigate(paths.newChat, { replace: true });
  };
}

export function SettingsRoute(): React.JSX.Element {
  const user = useAuthenticatedUser();
  const dismiss = useDismiss();
  return <SettingsPanel user={user} onClose={dismiss} />;
}

export function AdminRoute(): React.JSX.Element {
  const user = useAuthenticatedUser();
  const dismiss = useDismiss();

  /*
   * A courtesy, not the enforcement. The server checks the role on every admin
   * route (INV-24) and this cannot weaken that — it only stops a non-admin who
   * typed the URL from being shown a panel whose every request will 403.
   */
  if (user.role !== 'admin') return <Navigate to={paths.newChat} replace />;

  return <AdminPanel user={user} onClose={dismiss} />;
}
