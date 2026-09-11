import { SESSION_COOKIE, type SessionManager } from './sessions.ts';

/**
 * A signed-in HTTP client for tests.
 *
 * Every protected route now needs both a session cookie and a CSRF token, so
 * threading them by hand through every test would bury the assertions. This
 * attaches them exactly as a browser would, which means the tests still
 * exercise the real middleware rather than bypassing it.
 */
export interface TestClient {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  userId: string;
  token: string;
  csrfToken: string;
}

export async function signIn(
  base: string,
  sessions: SessionManager,
  userId: string
): Promise<TestClient> {
  const session = await sessions.create(userId);

  return {
    userId,
    token: session.token,
    csrfToken: session.csrfToken,
    fetch: (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          Cookie: `${SESSION_COOKIE}=${encodeURIComponent(session.token)}`,
          'X-CSRF-Token': session.csrfToken,
          ...init.headers,
        },
      }),
  };
}

/** A client with a session cookie but no CSRF token, for negative tests. */
export function withoutCsrf(client: TestClient, base: string): TestClient['fetch'] {
  return (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(client.token)}`,
        ...init.headers,
      },
    });
}
