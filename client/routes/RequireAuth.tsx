import { Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../Spinner.tsx';
import { paths } from './paths.ts';
import { useAppSession } from './session.ts';

/**
 * The authentication boundary, as a layout route.
 *
 * One place decides whether a signed-out visitor may see a screen, so a route
 * added later is protected by where it is declared rather than by remembering
 * to add a check to it. That is the whole reason it is a layout route and not a
 * wrapper component repeated around each element.
 *
 * **Waiting is not the same as being signed out.** While the session request is
 * in flight `authState` is `unknown`, and redirecting then would bounce every
 * reader through the login screen on every cold load — including the ones who
 * are signed in, who would see it flash and vanish. So `unknown` renders the
 * same boot placeholder the application had before there were routes.
 */
export function RequireAuth(): React.JSX.Element {
  const { authState } = useAppSession();
  const location = useLocation();

  if (authState === 'unknown') {
    return (
      <main className="booting">
        <Spinner />
      </main>
    );
  }

  if (authState === 'unauthenticated') {
    /*
     * Where they were going is carried across, so signing in returns them to
     * it instead of to a generic landing page. `replace` keeps the protected
     * URL out of history: pressing Back from the login screen should not walk
     * into a page that will only redirect here again.
     */
    return <Navigate to={paths.login} state={{ from: location }} replace />;
  }

  return <Outlet />;
}
