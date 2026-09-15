import { useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { App } from '../App.tsx';
import { CONVERSATION_PARAM, paths } from './paths.ts';
import { useAppSession, useAuthenticatedUser } from './session.ts';

/**
 * The chat screen, with the URL as the source of truth for which conversation.
 *
 * This is the adapter between the router and `App`, which still takes an id and
 * a setter. Keeping the translation in one small component means `App` did not
 * have to learn about routing to be routed — it asks for "the open conversation
 * and a way to change it", and where that comes from is this file's business.
 *
 * `/chat/new` is a **draft**, not a creation. Nothing is written when it is
 * visited: the conversation is created by the server when the first message is
 * sent, and only then does the URL acquire an id. Creating on navigation would
 * leave an empty conversation behind every time someone clicked New chat and
 * changed their mind — which is the behaviour this application deliberately
 * removed.
 */

export interface ChatRouteProps {
  draft: string;
  onDraftChange: (value: string) => void;
}

export function ChatRoute({ draft, onDraftChange }: ChatRouteProps): React.JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthenticatedUser();
  const { onSignOut } = useAppSession();

  // Absent on `/chat/new`, which is exactly the draft case.
  const currentId = params[CONVERSATION_PARAM] ?? null;

  const onSelectConversation = useCallback(
    (id: string | null) => {
      void navigate(id === null ? paths.newChat : paths.chat(id));
    },
    [navigate]
  );

  const onConversationCreated = useCallback(
    (id: string) => {
      void navigate(paths.chat(id), { replace: true });
    },
    [navigate]
  );

  /*
   * The screen underneath is carried in history state, so the panel opens over
   * the conversation being read rather than over a blank one. A direct visit to
   * /settings has no such state and falls back to the draft screen, which is
   * why `AppRoutes` can render the panel either way.
   */
  const openOverlay = useCallback(
    (to: string) => () => {
      void navigate(to, { state: { background: location } });
    },
    [navigate, location]
  );

  return (
    <App
      user={user}
      currentId={currentId}
      onSelectConversation={onSelectConversation}
      draft={draft}
      onDraftChange={onDraftChange}
      onConversationCreated={onConversationCreated}
      onOpenSettings={openOverlay(paths.settings)}
      onOpenAdmin={openOverlay(paths.admin)}
      onSignOut={onSignOut}
    />
  );
}
