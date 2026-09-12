import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Root } from './Root.tsx';
import {
  conversationBody,
  conversationsBody,
  installTestServer,
  modelsBody,
  sessionBody,
  type TestServer,
} from './test-server.ts';

/**
 * Search, end to end through the real shell.
 *
 * The two properties worth holding are the ones a unit test of the palette
 * would miss: that a result actually opens its conversation, and that arriving
 * at a particular message marks that message rather than some other one.
 */

let server: TestServer;

beforeEach(() => {
  server = installTestServer();
  window.localStorage.clear();
});

afterEach(() => {
  server.restore();
});

async function mountSignedIn(): Promise<void> {
  render(<Root />);
  await server.waitFor('/api/auth/session');
  server.respond('/api/auth/session', sessionBody());
  await server.waitFor('/api/conversations');
  server.respond('/api/conversations', conversationsBody([{ id: 'c1', title: 'First' }]));
  await server.waitFor('/api/models');
  server.respond('/api/models', modelsBody());
  await screen.findByLabelText('Message');
}

/** Opens the palette and gets as far as a rendered result list. */
async function search(query: string, results: unknown[]): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.type(screen.getByLabelText('Search conversations and messages'), query);

  await server.waitFor('/api/conversations/search');
  server.respond('/api/conversations/search', { results });
}

describe('search', () => {
  it('sends the typed query to the server rather than filtering what it already has', async () => {
    await mountSignedIn();
    await search('sourdough', []);

    const request = server.requests.find((r) => r.url.includes('/api/conversations/search'));
    expect(request?.url).toContain('q=sourdough');
  });

  it('opens the conversation a hit belongs to and marks the message it matched', async () => {
    await mountSignedIn();
    await search('sourdough', [
      {
        id: 'c2',
        title: 'Baking',
        updatedAt: '2026-01-01T00:00:00.000Z',
        titleMatch: false,
        hits: [{ messageId: 'm2', type: 'user', snippet: '…proof the sourdough…' }],
      },
    ]);

    const user = userEvent.setup();
    await user.click(await screen.findByText('…proof the sourdough…'));

    // The conversation the hit belongs to, not the one that was open.
    await server.waitFor('/api/conversations/c2');
    server.respond(
      '/api/conversations/c2',
      conversationBody('c2', [
        { type: 'user', id: 'm1', body: 'Something earlier.' },
        { type: 'user', id: 'm2', body: 'How long do I proof the sourdough?' },
      ])
    );

    await waitFor(() => {
      const marked = document.querySelector('.msg.is-found');
      expect(marked?.getAttribute('data-message-id')).toBe('m2');
    });
  });

  it('says so when nothing matched, rather than looking like it is still working', async () => {
    await mountSignedIn();
    await search('risotto', []);

    expect(await screen.findByText('Nothing matched.')).toBeTruthy();
  });
});
