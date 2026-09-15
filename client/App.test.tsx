import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth.ts';
import type * as ApiModule from './api.ts';

/**
 * The malformed-conversation state.
 *
 * A conversation whose file on disk is not valid `formatVersion: 1` Markdown
 * must be *shown*, not silently hidden or silently repaired: the contract is
 * that the file is left exactly as it was found. The UI's job is to explain
 * that and to offer the one action that is safe, which is deleting it.
 */

const { ApiError } = await vi.importActual<Api>('./api.ts');

type Api = typeof ApiModule;

const listConversations = vi.fn<Api['listConversations']>();
const getConversation = vi.fn<Api['getConversation']>();
const deleteConversation = vi.fn<Api['deleteConversation']>();
const fetchModels = vi.fn<Api['fetchModels']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return { ...actual, listConversations, getConversation, deleteConversation, fetchModels };
});

// Imported after the mock is registered.
const { App } = await import('./App.tsx');
const { createQueryClient } = await import('./queries.ts');

const USER: UserDto = {
  id: 'u-1',
  username: 'tester',
  role: 'user',
  status: 'active',
  createdAt: new Date().toISOString(),
};

const BROKEN = {
  id: 'c-broken',
  title: 'Broken conversation',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messageCount: 0,
  malformed: true,
};

beforeEach(() => {
  listConversations.mockResolvedValue([BROKEN]);
  fetchModels.mockResolvedValue({ providers: [], defaultModel: null });
  deleteConversation.mockResolvedValue(undefined);
  getConversation.mockRejectedValue(
    new ApiError('CONVERSATION_MALFORMED', 'This conversation file cannot be read.')
  );
});

/**
 * Renders `App` the way the shell does, with its own query client so no cache
 * survives from one test into the next.
 */
function renderApp(): { setCurrentId: ReturnType<typeof vi.fn> } {
  const setCurrentId = vi.fn();
  let currentId: string | null = null;

  function Harness(): React.JSX.Element {
    const [id, setId] = useState<string | null>(currentId);
    return (
      <App
        user={USER}
        currentId={id}
        onSelectConversation={(next) => {
          currentId = next;
          setCurrentId(next);
          setId(next);
        }}
        draft=""
        onDraftChange={vi.fn()}
        onConversationCreated={(next) => {
          currentId = next;
          setCurrentId(next);
          setId(next);
        }}
        onOpenSettings={vi.fn()}
        onOpenAdmin={vi.fn()}
        onOpenArtifacts={vi.fn()}
        onSignOut={vi.fn()}
      />
    );
  }

  render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness />
    </QueryClientProvider>
  );
  return { setCurrentId };
}

async function openBrokenConversation(): Promise<void> {
  const user = userEvent.setup();
  renderApp();

  // An exact name: "Delete Broken conversation" also contains the title.
  await user.click(await screen.findByRole('button', { name: 'Broken conversation' }));
}

describe('a malformed conversation', () => {
  it('explains the problem instead of showing an empty transcript', async () => {
    await openBrokenConversation();

    expect(await screen.findByText('This conversation cannot be read')).toBeTruthy();
    // Not reported as a generic failure, which would suggest retrying.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the file was left untouched', async () => {
    await openBrokenConversation();

    const explanation = await screen.findByText(/Nothing has been changed or repaired/);
    expect(explanation.textContent).toContain('exactly as it was found');
  });

  it('offers delete and nothing else', async () => {
    await openBrokenConversation();

    expect(await screen.findByRole('button', { name: 'Delete conversation' })).toBeTruthy();

    // The composer cannot be used to append to a file that cannot be parsed.
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').disabled).toBe(true);
  });

  it('marks the conversation in the list and withholds rename', async () => {
    const user = userEvent.setup();
    await openBrokenConversation();

    await user.click(await screen.findByRole('button', { name: /^Actions for Broken/ }));

    // Rename and Download both have to read the file, so neither is offered
    // for one that cannot be parsed. Deleting it does not need to read it.
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Download' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('deletes only after the confirmation is accepted', async () => {
    const user = userEvent.setup();
    await openBrokenConversation();

    await user.click(await screen.findByRole('button', { name: 'Delete conversation' }));

    // The dialog stands between the click and the destructive call.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Delete this conversation?');
    expect(deleteConversation).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('c-broken'));
  });

  it('cancelling the confirmation deletes nothing', async () => {
    const user = userEvent.setup();
    await openBrokenConversation();

    await user.click(await screen.findByRole('button', { name: 'Delete conversation' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteConversation).not.toHaveBeenCalled();
  });
});
