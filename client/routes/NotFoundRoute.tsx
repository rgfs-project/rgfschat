import { Link } from 'react-router';
import { paths } from './paths.ts';

/**
 * An address this application does not have.
 *
 * Worth a screen rather than a silent redirect: a mistyped or stale link that
 * quietly lands on the chat looks like the link worked and the conversation
 * vanished. Saying so, and offering the two places worth going, is shorter to
 * understand than that.
 *
 * A conversation id that is well-formed but gone is *not* this — that is a
 * real route whose data 404s, and the chat screen reports it in place.
 */
export function NotFoundRoute(): React.JSX.Element {
  return (
    <main className="page page--centred">
      <h1 className="page__title">This page does not exist</h1>
      <p className="muted">
        The address may be mistyped, or it may have been a link to something that has since been
        deleted.
      </p>
      <div className="page__actions">
        <Link className="nav-button" to={paths.newChat}>
          New chat
        </Link>
        <Link className="nav-button" to={paths.chats}>
          All conversations
        </Link>
      </div>
    </main>
  );
}
