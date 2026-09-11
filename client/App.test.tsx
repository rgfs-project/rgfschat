import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  fetchModels.mockResolvedValue([]);
  deleteConversation.mockResolvedValue(undefined);
  getConversation.mockRejectedValue(
    new ApiError('CONVERSATION_MALFORMED', 'This conversation file cannot be read.')
  );
});

async function openBrokenConversation(): Promise<void> {
  const user = userEvent.setup();
  render(<App user={USER} onSignOut={vi.fn()} />);

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
    await openBrokenConversation();

    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull();
    expect(screen.getByRole('button', { name: /^Delete Broken conversation/ })).toBeTruthy();
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
