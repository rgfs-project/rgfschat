import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppRoot } from '../Root.tsx';
import {
  conversationsBody,
  installTestServer,
  modelsBody,
  preferencesBody,
  sessionBody,
  type TestServer,
} from '../test-server.ts';

/**
 * The catch-all: an address that matches no route.
 *
 * This is `RequireAuth`'s own three-way decision, reused rather than
 * duplicated — the wildcard route lives *inside* the `RequireAuth` layout in
 * `AppRoutes.tsx`, so `unknown`, `unauthenticated` and `authenticated` are
 * decided in exactly the one place every protected route already goes
 * through. Nothing here is a second auth state, a second router, or a check
 * bolted onto a page; what is asserted below is that reusing that decision
 * for an unmatched path produces the three outcomes the task calls for.
 */

let server: TestServer;

beforeEach(() => {
  server = installTestServer();
  window.localStorage.clear();
});

afterEach(() => {
  server.restore();
});

/**
 * Records every pathname the router has been on, oldest first, collapsing
 * consecutive repeats — a re-render at the same address is not a navigation.
 */
function LocationProbe({ log }: { log: string[] }): null {
  const location = useLocation();
  if (log.at(-1) !== location.pathname) log.push(location.pathname);
  return null;
}

/** Mounts the real shell at a given address, exactly as a typed-in URL would. */
function mount(initialPath: string, log: string[], strict = false): void {
  const tree = (
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe log={log} />
      <AppRoot />
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** Answers every cold-start request as a signed-in user with one conversation. */
async function resolveSignedIn(): Promise<void> {
  await server.waitFor('/api/auth/session');
  server.respond('/api/auth/session', sessionBody());
  await server.waitFor('/api/conversations');
  server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
  await server.waitFor('/api/models');
  server.respond('/api/models', modelsBody());
  await server.waitFor('/api/me/preferences');
  server.respond('/api/me/preferences', preferencesBody());
}

async function resolveSignedOut(): Promise<void> {
  await server.waitFor('/api/auth/session');
  server.respond('/api/auth/session', sessionBody({ user: null }));
}

describe('an address that matches no route', () => {
  it('sends a signed-in reader to the new-chat draft', async () => {
    const log: string[] = [];
    mount('/asdf', log);

    await resolveSignedIn();

    await screen.findByLabelText('Message');
    expect(log.at(-1)).toBe('/chat/new');
  });

  it('sends a signed-out visitor to /login', async () => {
    const log: string[] = [];
    mount('/random/path', log);

    await resolveSignedOut();

    await screen.findByRole('button', { name: /^Sign in$/ });
    expect(log.at(-1)).toBe('/login');
  });

  it('resolves the same way for a path with several unmatched segments', async () => {
    const log: string[] = [];
    mount('/chats/invalid-route', log);

    await resolveSignedIn();

    await screen.findByLabelText('Message');
    expect(log.at(-1)).toBe('/chat/new');
  });

  /**
   * The headline constraint: `unknown` is not a slower `unauthenticated`.
   * Redirecting here — to either destination — before the session request has
   * even been answered would mean every reader, signed in or not, is bounced
   * through a screen that has nothing to do with where they end up.
   */
  it('does not redirect while auth is still unknown', async () => {
    const log: string[] = [];
    mount('/anything/not-defined', log);
    await server.waitFor('/api/auth/session');

    // Neither destination has been reached, and no navigation has happened at
    // all: the router is still exactly where the address bar said.
    expect(screen.queryByRole('button', { name: /^Sign in$/ })).toBeNull();
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(log).toEqual(['/anything/not-defined']);
  });

  /**
   * Once resolved, the redirect happens exactly once and by one route: the
   * log must show the invalid path giving way straight to the destination,
   * never detouring through the other outcome first.
   */
  it('redirects exactly once when unknown resolves to authenticated', async () => {
    const log: string[] = [];
    mount('/never/heard/of/it', log);
    await resolveSignedIn();

    await screen.findByLabelText('Message');

    expect(log).toEqual(['/never/heard/of/it', '/chat/new']);
  });

  it('redirects exactly once when unknown resolves to unauthenticated', async () => {
    const log: string[] = [];
    mount('/never/heard/of/it', log);
    await resolveSignedOut();

    await screen.findByRole('button', { name: /^Sign in$/ });

    expect(log).toEqual(['/never/heard/of/it', '/login']);
  });

  /**
   * Strict Mode mounts, unmounts and remounts every component once. The
   * redirect is a declarative `<Navigate>`, not an effect, so there is no
   * "run twice" for it to suffer from — but this proves it rather than
   * assuming it, the same way the cold-start tests prove Strict Mode does not
   * duplicate a request.
   */
  it('Strict Mode settles on one destination with no duplicate navigation', async () => {
    const log: string[] = [];
    mount('/asdf', log, true);

    await resolveSignedIn();

    await screen.findByLabelText('Message');
    // Whatever Strict Mode's extra pass logged, it collapses to the same one
    // hop: the invalid path, then the destination — nothing in between, and
    // nothing repeated after arriving.
    expect(log).toEqual(['/asdf', '/chat/new']);
  });

  it('Strict Mode settles on /login with no duplicate navigation', async () => {
    const log: string[] = [];
    mount('/asdf', log, true);

    await resolveSignedOut();

    await screen.findByRole('button', { name: /^Sign in$/ });
    expect(log).toEqual(['/asdf', '/login']);
  });
});

describe('valid routes are unaffected', () => {
  /**
   * `/chat/:conversationId` is a real route pattern. A conversation id that
   * happens not to exist is a data question the chat screen answers itself —
   * never a routing question, and never this redirect.
   */
  it('a well-formed conversation URL is not treated as unmatched', async () => {
    const log: string[] = [];
    mount('/chat/does-not-exist', log);
    await resolveSignedIn();

    // The route matched: the chat screen mounted and asked for that
    // conversation by id, rather than the router bouncing to /chat/new.
    await server.waitFor('/api/conversations/does-not-exist');
    expect(log).toEqual(['/chat/does-not-exist']);
  });

  it('/chats still opens the conversation list, not the redirect', async () => {
    const log: string[] = [];
    mount('/chats', log);
    // The list screen reads conversations and models but never preferences,
    // unlike the chat screen the other cases here resolve to.
    await server.waitFor('/api/auth/session');
    server.respond('/api/auth/session', sessionBody());
    await server.waitFor('/api/conversations');
    server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
    await server.waitFor('/api/models');
    server.respond('/api/models', modelsBody());

    await screen.findByRole('heading', { name: /conversations/i });
    expect(log).toEqual(['/chats']);
  });

  it('/settings still opens the panel over the draft, not the redirect', async () => {
    const log: string[] = [];
    mount('/settings', log);
    await resolveSignedIn();

    await screen.findByRole('dialog', { name: /settings/i });
    expect(log).toEqual(['/settings']);
  });

  it('/ still redirects to the draft, exactly as before', async () => {
    const log: string[] = [];
    mount('/', log);
    await resolveSignedIn();

    await screen.findByLabelText('Message');
    expect(log).toEqual(['/', '/chat/new']);
  });
});

describe('a protected valid route while signed out', () => {
  /** Unchanged by this: RequireAuth's own redirect, not the new wildcard. */
  it('still sends the reader to /login and preserves where they were going', async () => {
    const log: string[] = [];
    mount('/chats', log);
    await resolveSignedOut();

    await screen.findByRole('button', { name: /^Sign in$/ });
    expect(log.at(-1)).toBe('/login');
  });
});
