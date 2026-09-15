/**
 * Every path this application knows, constructed in one place.
 *
 * Routes are strings, and strings typed at each call site drift: a rename ends
 * up half-applied and the half nobody clicked in testing is the half that
 * breaks. These are the only literals, and `to()` is the only way to build a
 * conversation URL — so a conversation id can never be concatenated into a path
 * by hand, which is the client-side echo of the same rule the server keeps for
 * the filesystem.
 */

export const paths = {
  /** The signed-out screen. Never behind `RequireAuth`. */
  login: '/login',

  /** A conversation that does not exist yet — a draft, not a creation. */
  newChat: '/chat/new',

  /** The conversation list as a place of its own, for narrow windows. */
  chats: '/chats',

  chat: (conversationId: string): string => `/chat/${encodeURIComponent(conversationId)}`,

  settings: '/settings',
  admin: '/admin',

  /** The artifact gallery: every code block, across every conversation. */
  artifacts: '/artifacts',
} as const;

/**
 * The route patterns, separate from the paths above.
 *
 * `chat` is a function that builds a URL; the router needs the pattern it was
 * built from. Keeping both here means the two cannot disagree about where the
 * parameter sits.
 */
export const patterns = {
  login: '/login',
  newChat: '/chat/new',
  chats: '/chats',
  chat: '/chat/:conversationId',
  settings: '/settings',
  admin: '/admin',
  artifacts: '/artifacts',
} as const;

/**
 * The name of the route parameter, so `useParams` and the pattern above are
 * spelled once.
 */
export const CONVERSATION_PARAM = 'conversationId';

/**
 * The search parameter that opens the artifact panel beside a conversation.
 *
 * A query parameter rather than a path segment: the panel is a view *of* the
 * conversation already addressed by the path, not a different screen, so
 * `/chat/:id?artifact=…` keeps one address for "this conversation, with this
 * block open" and leaves the conversation route itself unchanged.
 */
export const ARTIFACT_PARAM = 'artifact';
