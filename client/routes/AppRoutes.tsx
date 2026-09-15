import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ChatRoute } from './ChatRoute.tsx';
import { ChatsIndexRoute } from './ChatsIndexRoute.tsx';
import { LoginRoute } from './LoginRoute.tsx';
import { AdminRoute, SettingsRoute } from './OverlayRoutes.tsx';
import { RequireAuth } from './RequireAuth.tsx';
import { patterns, paths } from './paths.ts';
import type { Location } from 'react-router';

/**
 * Every address in the application.
 *
 * Two route tables, rendered one over the other, which is how an overlay gets
 * to be a URL without stopping being an overlay.
 *
 * The **background** table draws the screen. Normally it draws the current
 * location. When a panel was opened from inside the application, the location
 * it was opened *from* is carried in history state, and that is drawn instead —
 * so the conversation you were reading stays on screen behind Settings rather
 * than being replaced by a blank one.
 *
 * The **overlay** table draws the panel, if the real location names one. It is
 * independent of how the location was reached, which is what makes a pasted
 * link to /settings work: there is no background to draw, so the background
 * table falls back to the draft screen, and the panel opens over that.
 *
 * The alternative — nesting the panels under `/chat/:conversationId/settings` —
 * keeps the conversation in the URL without any of this, at the cost of the
 * short addresses that were asked for.
 *
 * **An address that matches nothing** is handled by a catch-all *inside* the
 * `RequireAuth` layout, not beside it — that is what makes it resolve the same
 * way every protected route already does, with no auth logic of its own:
 * `unknown` gets the boot placeholder, `unauthenticated` is sent to `/login`,
 * and only `authenticated` ever reaches the catch-all's own element, which
 * sends it on to the new-chat draft. A route pattern not matching is a routing
 * question; a well-formed `/chat/:conversationId` naming a conversation that
 * does not exist is a data question, answered by the chat screen itself
 * (contracts §7) — the two are not the same failure and this only ever
 * touches the first.
 */

interface BackgroundState {
  background?: Location;
}

export interface AppRoutesProps {
  draft: string;
  onDraftChange: (value: string) => void;
}

export function AppRoutes({ draft, onDraftChange }: AppRoutesProps): React.JSX.Element {
  const location = useLocation();
  const state = location.state as BackgroundState | null;
  const background = state?.background;

  const chat = <ChatRoute draft={draft} onDraftChange={onDraftChange} />;

  return (
    <>
      <Routes location={background ?? location}>
        <Route path={patterns.login} element={<LoginRoute />} />

        <Route element={<RequireAuth />}>
          {/* `/` is not a screen of its own: there is nothing to show that is
              not either a conversation or the start of one. */}
          <Route path="/" element={<Navigate to={paths.newChat} replace />} />

          <Route path={patterns.newChat} element={chat} />
          <Route path={patterns.chat} element={chat} />
          <Route path={patterns.chats} element={<ChatsIndexRoute />} />

          {/*
            The panels appear in this table as well as the one below. Without
            these two, a direct visit to /settings would find no match here and
            render the catch-all behind the panel.
          */}
          <Route path={patterns.settings} element={chat} />
          <Route path={patterns.admin} element={chat} />

          {/*
            Every other address. A child of `RequireAuth` rather than a sibling
            of it, so it goes through the exact same three-way decision as
            every route above it — this element only ever mounts once that
            decision has already come out `authenticated`.
          */}
          <Route path="*" element={<Navigate to={paths.newChat} replace />} />
        </Route>
      </Routes>

      <Routes>
        <Route element={<RequireAuth />}>
          <Route path={patterns.settings} element={<SettingsRoute />} />
          <Route path={patterns.admin} element={<AdminRoute />} />
        </Route>
        {/* Every other address draws no overlay. `null`, not a fallback screen:
            the background table has already drawn whatever belongs there. */}
        <Route path="*" element={null} />
      </Routes>
    </>
  );
}
