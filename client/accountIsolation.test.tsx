import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { AppRoot } from './Root.tsx';
import { createQueryClient } from './queries.ts';
import {
  conversationsBody,
  installTestServer,
  modelsBody,
  preferencesBody,
  sessionBody,
  type TestServer,
} from './test-server.ts';

/**
 * One browser tab, two accounts.
 *
 * Signing out and signing in as somebody else is an ordinary thing to do on a
 * shared machine, and it happens without the page ever reloading — so every
 * cache the first account filled is still there when the second arrives.
 * Conversations and models were dropped on sign-out; preferences, memories,
 * artifacts and search results were not, and nothing in their keys said whose
 * they were. The next account would be handed them from cache, before any
 * request of their own had been answered.
 *
 * Asserted against the cache itself rather than only through the screen: a
 * leak no component happens to render today is still a leak, and the next
 * component added is the one that finds it.
 */

let server: TestServer;
let client: QueryClient;

beforeEach(() => {
  server = installTestServer();
  client = createQueryClient();
  window.localStorage.clear();
});

afterEach(() => {
  server.restore();
});

function mount(): void {
  render(
    <MemoryRouter initialEntries={['/chat/new']}>
      <AppRoot client={client} />
    </MemoryRouter>
  );
}

/**
 * Answers the requests an account's arrival makes.
 *
 * `nth` says which arrival this is: a second account signing in to the same tab
 * asks for all of it a second time, and waiting for the first occurrence would
 * match the previous account's request rather than this one's.
 */
async function arriveAs(username: string, conversationTitle: string, nth = 1): Promise<void> {
  await server.waitFor('/api/auth/session', nth);
  server.respond(
    '/api/auth/session',
    sessionBody({
      user: {
        id: `id-${username}`,
        username,
        role: 'user',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    })
  );

  /*
   * The remaining three are answered as they turn up rather than in a fixed
   * order. A second arrival is not a repeat of the first: clearing the previous
   * account's cache cancels its requests, so which of these are outstanding at
   * any moment differs, and waiting for one by position deadlocks against a
   * request that was aborted rather than answered.
   */
  for (let attempt = 0; attempt < 40; attempt += 1) {
    server.respondAll(
      '/api/conversations',
      conversationsBody([{ id: `c-${username}`, title: conversationTitle }])
    );
    server.respondAll('/api/models', modelsBody());
    server.respondAll('/api/me/preferences', preferencesBody());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function signOut(): Promise<void> {
  const user = userEvent.setup();
  // The account button is the sidebar footer's own control; at the narrow
  // width jsdom reports, the sidebar may need opening first.
  const account = document.querySelector('.account');
  if (account === null) throw new Error('no account control on screen');
  await user.click(account);
  await user.click(await screen.findByRole('menuitem', { name: /sign out/i }));
  await server.waitFor('/api/auth/logout');
  server.respond('/api/auth/logout', {});
  await screen.findByRole('button', { name: /^Sign in$/ });
}

/** Every query key currently held, newest spelling first. */
function cachedKeys(): string[] {
  return client
    .getQueryCache()
    .getAll()
    .map((query) => JSON.stringify(query.queryKey));
}

describe('signing out', () => {
  it('leaves nothing of the account behind in the cache', async () => {
    mount();
    await arriveAs('alice', 'Alice private notes');
    await screen.findByText('Alice private notes');

    // The account's own settings were read on arrival, and are the clearest
    // case of something private that sign-out used to leave sitting there.
    expect(cachedKeys()).toContain(JSON.stringify(['me', 'preferences']));

    await signOut();

    await waitFor(() => {
      // The session query is the one thing that legitimately survives: it is
      // what says nobody is signed in.
      expect(cachedKeys().filter((key) => key !== JSON.stringify(['session']))).toEqual([]);
    });
  });

  it('takes the previous account off the screen', async () => {
    mount();
    await arriveAs('alice', 'Alice private notes');
    await screen.findByText('Alice private notes');

    await signOut();

    expect(screen.queryByText('Alice private notes')).toBeNull();
  });
});

describe('a second account signing in afterwards', () => {
  it('is never shown the first account’s conversations', async () => {
    mount();
    await arriveAs('alice', 'Alice private notes');
    await screen.findByText('Alice private notes');
    await signOut();

    // Bob signs in, in the same tab. Everything he sees must come from a
    // request answered for him.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Username'), 'bob');
    await user.type(screen.getByLabelText('Password'), 'bobs-passphrase');
    await user.click(screen.getByRole('button', { name: /^Sign in$/ }));

    await server.waitFor('/api/auth/login');
    server.respond('/api/auth/login', {
      user: {
        id: 'id-bob',
        username: 'bob',
        role: 'user',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      csrfToken: 'csrf-bob',
    });

    await arriveAs('bob', 'Bob own notes', 2);

    await screen.findByText('Bob own notes');
    expect(screen.queryByText('Alice private notes')).toBeNull();
    expect(cachedKeys().join(' ')).not.toContain('c-alice');
  });
});
