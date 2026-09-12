import { Link } from 'react-router';
import { useConversations } from '../queries.ts';
import { paths } from './paths.ts';

/**
 * The conversation list as a place of its own.
 *
 * On a wide window the sidebar already shows this, so `/chats` is mostly a
 * narrow-window affordance and a URL worth linking to — "here is my list" —
 * rather than a new way to read conversations.
 *
 * Real `<Link>`s, not buttons that navigate. A list of destinations should be
 * middle-clickable, openable in a new tab, and copyable as a link; a button
 * with an `onClick` that calls `navigate` looks identical and is none of those
 * things.
 */
export function ChatsIndexRoute(): React.JSX.Element {
  const conversations = useConversations(true);
  const list = conversations.data ?? [];

  return (
    <main className="page">
      <header className="page__header">
        <h1 className="page__title">Conversations</h1>
        <Link className="nav-button" to={paths.newChat}>
          New chat
        </Link>
      </header>

      {conversations.isPending && list.length === 0 && <p className="muted">Loading…</p>}

      {!conversations.isPending && list.length === 0 && (
        <p className="muted">No conversations yet. Send a message to begin one.</p>
      )}

      <ul className="page__list">
        {list.map((conversation) => (
          <li key={conversation.id}>
            <Link className="page__list-item" to={paths.chat(conversation.id)}>
              <span className="page__list-title">
                {conversation.malformed && (
                  <span className="conversation__warning" aria-hidden="true">
                    ⚠
                  </span>
                )}
                {conversation.title}
              </span>
              <time className="muted" dateTime={conversation.updatedAt}>
                {new Date(conversation.updatedAt).toLocaleDateString()}
              </time>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
