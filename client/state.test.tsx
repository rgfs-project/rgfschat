import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from './Root.tsx';
import { MemoryRouter } from 'react-router';
import {
  conversationBody,
  conversationsBody,
  installTestServer,
  modelsBody,
  preferencesBody,
  sessionBody,
  type TestServer,
} from './test-server.ts';

/**
 * Client state, loading, and request lifecycle.
 *
 * These assert *behaviour under timing*, which is the only way most of this
 * phase's properties are visible at all: against a mock that answers instantly
 * every ordering looks correct. The server stand-in holds each request open so
 * the test decides what resolves, and in which order.
 */

let server: TestServer;

beforeEach(() => {
  server = installTestServer();
  window.localStorage.clear();
});

afterEach(() => {
  server.restore();
});

/** Mounts the real shell, exactly as `main.tsx` does. */
function mount(strict = false): void {
  /*
   * A `MemoryRouter` per mount, not the application's `BrowserRouter`: that one
   * reads jsdom's single shared history, so whichever test ran last decided
   * which screen the next one started on.
   */
  const tree = (
    <MemoryRouter initialEntries={['/chat/new']}>
      <AppRoot />
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** Signs in and gets as far as a rendered composer. */
async function mountSignedIn(
  conversations: { id: string; title: string }[] = [{ id: 'c1', title: 'First' }]
): Promise<void> {
  mount();
  await server.waitFor('/api/auth/session');
  server.respond('/api/auth/session', sessionBody());
  await server.waitFor('/api/conversations');
  server.respond('/api/conversations', conversationsBody(conversations));
  await server.waitFor('/api/models');
  server.respond('/api/models', modelsBody());
  await server.waitFor('/api/me/preferences');
  server.respond('/api/me/preferences', preferencesBody());
  await screen.findByLabelText('Message');
}

describe('cold start', () => {
  /**
   * The headline property of this phase.
   *
   * Previously nothing but the session was even requested until the session had
   * come back, because the components that fetch the rest were only mounted for
   * an authenticated user. That made first paint three round trips deep for no
   * reason: none of the three needs another's *result*.
   */
  it('requests session, conversations and models concurrently', async () => {
    mount();

    await server.waitFor('/api/auth/session');
    await server.waitFor('/api/conversations');
    await server.waitFor('/api/models');

    // Timing evidence: all three were in flight before any had answered.
    expect(server.pending).toHaveLength(3);

    const session = server.requests.find((r) => r.url.includes('/api/auth/session'));
    const conversations = server.requests.find((r) => r.url.includes('/api/conversations'));
    const models = server.requests.find((r) => r.url.includes('/api/models'));

    expect(session).toBeDefined();
    expect(conversations).toBeDefined();
    expect(models).toBeDefined();
    // They started together rather than one after another.
    const spread = Math.max(conversations!.startedAt, models!.startedAt) - session!.startedAt;
    expect(spread).toBeLessThan(100);
  });

  it('shows neither signed-in nor signed-out UI while the session is unknown', async () => {
    mount();
    await server.waitFor('/api/auth/session');

    // No login form, and no application chrome either.
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('discards speculative data when the session turns out to be signed out', async () => {
    mount();
    await server.waitFor('/api/conversations');

    // The list answers first, for a user who then turns out not to be signed in.
    server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'Secret' }]));
    server.respond('/api/models', modelsBody());
    server.respond('/api/auth/session', sessionBody({ user: null }));

    await screen.findByRole('button', { name: /Sign in/ });
    expect(screen.queryByText('Secret')).toBeNull();
  });

  it('survives a slow network without flashing the wrong state', async () => {
    mount();
    await server.waitFor('/api/auth/session');

    // Conversations and models land long before the session does.
    server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
    server.respond('/api/models', modelsBody());

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

    server.respond('/api/auth/session', sessionBody());
    await screen.findByLabelText('Message');
    expect(screen.getByText('First')).toBeTruthy();
  });
});

describe('INV-23: a stale response never overwrites newer state', () => {
  it('an older conversation response resolving last does not win', async () => {
    await mountSignedIn([
      { id: 'c1', title: 'First' },
      { id: 'c2', title: 'Second' },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');

    // Switch before the first answers.
    await user.click(screen.getByRole('button', { name: 'Second' }));
    await server.waitFor('/api/conversations/c2');

    // The newer one answers first, then the older one arrives late.
    server.respond(
      '/api/conversations/c2',
      conversationBody('c2', [{ type: 'user', id: 'm2', body: 'belongs to second' }])
    );
    await screen.findByText('belongs to second');

    // c1's request was superseded and cancelled outright, so there is nothing
    // left to answer — which is the strongest form of "it cannot win".
    expect(server.pending.some((p) => p.url.includes('/api/conversations/c1'))).toBe(false);

    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('belongs to second')).toBeTruthy();
    expect(screen.queryByText('belongs to first')).toBeNull();
  });

  it('rapid conversation switching settles on the last one chosen', async () => {
    await mountSignedIn([
      { id: 'c1', title: 'First' },
      { id: 'c2', title: 'Second' },
      { id: 'c3', title: 'Third' },
    ]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'First' }));
    await user.click(screen.getByRole('button', { name: 'Second' }));
    await user.click(screen.getByRole('button', { name: 'Third' }));

    await server.waitFor('/api/conversations/c3');
    server.respond(
      '/api/conversations/c3',
      conversationBody('c3', [{ type: 'user', id: 'm3', body: 'third content' }])
    );

    await screen.findByText('third content');
  });

  it('deduplicates identical in-flight requests', async () => {
    await mountSignedIn([{ id: 'c1', title: 'First' }]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');
    const after = server.countOf('/api/conversations/c1');

    // Selecting the same conversation again must not start a second read.
    await user.click(screen.getByRole('button', { name: 'First' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(server.countOf('/api/conversations/c1')).toBe(after);
  });
});

describe('Strict Mode', () => {
  /**
   * Strict Mode mounts every component twice. The old code defended against
   * that with run-once refs; the data layer makes the defence unnecessary,
   * which is what this checks.
   */
  it('double-mounting never has two identical reads in flight at once', async () => {
    mount(true);

    await server.waitFor('/api/auth/session');
    await server.waitFor('/api/conversations');
    await server.waitFor('/api/models');
    await new Promise((r) => setTimeout(r, 30));

    /*
     * Strict Mode unmounts and remounts, which cancels each in-flight read and
     * starts it again — so a route can legitimately be *requested* twice. What
     * must never happen is two live requests for the same key at the same time,
     * because that is the case where the loser can overwrite the winner.
     */
    for (const route of ['/api/auth/session', '/api/conversations', '/api/models']) {
      expect(server.pending.filter((p) => p.url.includes(route))).toHaveLength(1);
    }
  });

  it('double-mounting does not duplicate a mutation', async () => {
    mount(true);
    await server.waitFor('/api/auth/session');
    server.respond('/api/auth/session', sessionBody());
    await server.waitFor('/api/conversations');
    server.respond('/api/conversations', conversationsBody([]));
    await server.waitFor('/api/models');
    server.respond('/api/models', modelsBody());
    await server.waitFor('/api/me/preferences');
    server.respondAll('/api/me/preferences', preferencesBody());

    // Sending is what creates a conversation, so that is the mutation to watch.
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Message'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await server.waitFor('/api/conversations', 2);
    await new Promise((r) => setTimeout(r, 30));

    // One POST, not two.
    const posts = server.requests.filter(
      (r) => r.method === 'POST' && r.url.includes('/api/conversations')
    );
    expect(posts).toHaveLength(1);
  });

  /**
   * The list is for conversations, not for intentions.
   *
   * Creating on the click meant opening a new chat and changing your mind left
   * an empty conversation behind, and a handful of those are indistinguishable
   * from each other in the sidebar.
   */
  it('New chat creates nothing until there is a message to put in it', async () => {
    mount();
    await server.waitFor('/api/auth/session');
    server.respond('/api/auth/session', sessionBody());
    await server.waitFor('/api/conversations');
    server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
    await server.waitFor('/api/models');
    server.respond('/api/models', modelsBody());

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');
    server.respond('/api/conversations/c1', conversationBody('c1'));

    await user.click(screen.getByRole('button', { name: 'New chat' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    // It is a cleared view, not a stored conversation: the composer is ready.
    expect(screen.getByLabelText('Message').hasAttribute('disabled')).toBe(false);
  });
});

describe('optimistic send', () => {
  it('shows the message immediately and reconciles it to the server id', async () => {
    await mountSignedIn([{ id: 'c1', title: 'First' }]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');
    server.respond('/api/conversations/c1', conversationBody('c1'));

    const composer = await screen.findByLabelText<HTMLTextAreaElement>('Message');
    await waitFor(() => expect(composer.disabled).toBe(false));
    await user.type(composer, 'hello there');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    // Visible before the server has said anything.
    await screen.findByText('hello there');
    await server.waitFor('/api/generations');

    server.respond('/api/generations', {
      generationId: 'g1',
      userMessageId: 'server-user-id',
      assistantMessageId: 'server-assistant-id',
    });

    // Still exactly one copy: reconciled in place, not appended alongside.
    await waitFor(() => expect(screen.getAllByText('hello there')).toHaveLength(1));
  });

  it('rolls the message back when the send fails', async () => {
    await mountSignedIn([{ id: 'c1', title: 'First' }]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');
    server.respond('/api/conversations/c1', conversationBody('c1'));

    const composer = await screen.findByLabelText<HTMLTextAreaElement>('Message');
    await waitFor(() => expect(composer.disabled).toBe(false));
    await user.type(composer, 'doomed message');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await screen.findByText('doomed message');
    await server.waitFor('/api/generations');
    server.fail('/api/generations', 503, 'PROVIDER_UNAVAILABLE', 'The provider is unreachable.');

    // Gone from the transcript, because the server never received it…
    await waitFor(() => {
      const transcript = screen.getByTestId('transcript');
      expect(transcript.textContent).not.toContain('doomed message');
    });
    // …and returned to the composer rather than silently lost.
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('doomed message')
    );
    expect(screen.getByRole('alert').textContent).toContain('unreachable');
  });
});

describe('session expiry mid-use', () => {
  it('moves to signed out, keeps the draft, and returns to the conversation', async () => {
    await mountSignedIn([{ id: 'c1', title: 'First' }]);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');
    server.respond('/api/conversations/c1', conversationBody('c1'));

    const composer = await screen.findByLabelText<HTMLTextAreaElement>('Message');
    await waitFor(() => expect(composer.disabled).toBe(false));
    await user.type(composer, 'half-written thought');

    // The session goes while the user is mid-sentence.
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await server.waitFor('/api/generations');
    server.fail('/api/generations', 401, 'UNAUTHENTICATED', 'You must sign in to do that.');

    await screen.findByRole('button', { name: /Sign in/ });
    expect(screen.getByRole('status').textContent).toContain('session ended');

    // Sign back in.
    await user.type(screen.getByLabelText('Username'), 'tester');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /Sign in/ }));

    await server.waitFor('/api/auth/login');
    server.respond('/api/auth/login', { user: sessionBody().user, csrfToken: 'csrf-2' });
    await server.waitFor('/api/auth/session', 2);
    server.respond('/api/auth/session', sessionBody());
    server.respondAll('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
    server.respondAll('/api/models', modelsBody());

    // Same conversation, and the unsent text is still there.
    const restored = await screen.findByLabelText<HTMLTextAreaElement>('Message');
    await waitFor(() => expect(restored.value).toBe('half-written thought'));
  });
});

describe('error boundaries', () => {
  it('contains a transcript failure and recovers on retry', async () => {
    await mountSignedIn([{ id: 'c1', title: 'First' }]);
    const user = userEvent.setup();

    // A body that is not a string makes Markdown throw while rendering.
    await user.click(screen.getByRole('button', { name: 'First' }));
    await server.waitFor('/api/conversations/c1');
    server.respond('/api/conversations/c1', {
      ...conversationBody('c1'),
      messages: [{ type: 'user', id: 'm1', body: { not: 'a string' } }],
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('transcript');

    // The sidebar is untouched: the blast radius matched the failure.
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('empty states', () => {
  it('says so when there are no conversations', async () => {
    await mountSignedIn([]);
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
  });

  it('says so when no models are configured', async () => {
    mount();
    await server.waitFor('/api/auth/session');
    server.respond('/api/auth/session', sessionBody());
    await server.waitFor('/api/conversations');
    server.respond('/api/conversations', conversationsBody([]));
    await server.waitFor('/api/models');
    server.respond('/api/models', { providers: [] });

    expect(await screen.findByText(/No models are configured/)).toBeTruthy();
  });

  it('says so when every provider is unreachable', async () => {
    mount();
    await server.waitFor('/api/auth/session');
    server.respond('/api/auth/session', sessionBody());
    await server.waitFor('/api/conversations');
    server.respond('/api/conversations', conversationsBody([]));
    await server.waitFor('/api/models');
    server.respond('/api/models', modelsBody([{ id: 'model-a' }], 'unavailable'));

    expect(await screen.findByText(/Every provider is unreachable/)).toBeTruthy();
  });
});

describe('hard reload', () => {
  it('restores the signed-in shell from the session alone', async () => {
    // A reload is simply a fresh mount with no client state at all.
    await mountSignedIn([{ id: 'c1', title: 'Survivor' }]);
    expect(screen.getByText('Survivor')).toBeTruthy();
    expect(screen.getByLabelText('Message')).toBeTruthy();
  });
});

/** Silences the expected React error-boundary logging for the whole file. */
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
