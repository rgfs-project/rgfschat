import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ChatRoute } from './ChatRoute.tsx';
import { ChatsIndexRoute } from './ChatsIndexRoute.tsx';
import { LoginRoute } from './LoginRoute.tsx';
import { NotFoundRoute } from './NotFoundRoute.tsx';
import { AdminRoute, ArtifactsRoute, SettingsRoute } from './OverlayRoutes.tsx';
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
            render the not-found screen behind the panel.
          */}
          <Route path={patterns.settings} element={chat} />
          <Route path={patterns.admin} element={chat} />
          <Route path={patterns.artifacts} element={chat} />
        </Route>

        <Route path="*" element={<NotFoundRoute />} />
      </Routes>

      <Routes>
        <Route element={<RequireAuth />}>
          <Route path={patterns.settings} element={<SettingsRoute />} />
          <Route path={patterns.admin} element={<AdminRoute />} />
          <Route path={patterns.artifacts} element={<ArtifactsRoute />} />
        </Route>
        {/* Every other address draws no overlay. `null`, not a fallback screen:
            the background table has already drawn whatever belongs there. */}
        <Route path="*" element={null} />
      </Routes>
    </>
  );
}
