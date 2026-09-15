import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';

/**
 * Clicking Send with an image and nothing typed.
 *
 * The button was enabled — the composer has always allowed "text *or* an
 * attachment" — and clicking it did nothing, because `send()` returned
 * immediately on an empty draft. From the reader's side that is a button that
 * lies, and the only way through was to type something meaningless which was
 * then shown under the image and used as the conversation's title.
 */

type Api = typeof ApiModule;

const { ApiError } = await vi.importActual<Api>('./api.ts');

const listConversations = vi.fn<Api['listConversations']>();
const getConversation = vi.fn<Api['getConversation']>();
const fetchModels = vi.fn<Api['fetchModels']>();
const fetchMyPreferences = vi.fn<Api['fetchMyPreferences']>();
const fetchProposals = vi.fn<Api['fetchProposals']>();
const createConversation = vi.fn<Api['createConversation']>();
const startGeneration = vi.fn<Api['startGeneration']>();
const uploadAttachment = vi.fn<Api['uploadAttachment']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    listConversations,
    getConversation,
    fetchModels,
    fetchMyPreferences,
    fetchProposals,
    createConversation,
    startGeneration,
    uploadAttachment,
  };
});

const { App } = await import('./App.tsx');
const { createQueryClient } = await import('./queries.ts');

const USER: UserDto = {
  id: 'u-1',
  username: 'tester',
  role: 'user',
  status: 'active',
  createdAt: new Date().toISOString(),
};

const NOW = new Date().toISOString();
const ATTACHMENT = {
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'diagram.png',
  mediaType: 'image/png' as const,
  kind: 'image' as const,
  size: 128,
  createdAt: NOW,
};

beforeEach(() => {
  localStorage.clear();
  listConversations.mockResolvedValue([]);
  fetchModels.mockResolvedValue({
    providers: [
      {
        providerId: 'local',
        providerName: 'Local',
        status: 'ready',
        models: [{ id: 'vision', loaded: true, inputModalities: ['text', 'image'] }],
      },
    ],
    defaultModel: null,
  } as unknown as Awaited<ReturnType<Api['fetchModels']>>);
  fetchMyPreferences.mockResolvedValue({ pinned: [], defaultModel: null } as unknown as Awaited<
    ReturnType<Api['fetchMyPreferences']>
  >);
  fetchProposals.mockResolvedValue([]);
  getConversation.mockResolvedValue({
    id: 'c-1',
    title: 'New conversation',
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    activeGenerationId: null,
  });
  createConversation.mockResolvedValue({ id: 'c-1' } as unknown as Awaited<
    ReturnType<Api['createConversation']>
  >);
  startGeneration.mockResolvedValue({
    generationId: 'g-1',
    userMessageId: 'u-new',
    assistantMessageId: 'a-new',
  });
  uploadAttachment.mockResolvedValue(ATTACHMENT);
  vi.stubGlobal(
    'EventSource',
    class {
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderApp(): { draft: () => string } {
  let draft = '';

  function Shell(): React.JSX.Element {
    const [id, setId] = useState<string | null>('c-1');
    const [value, setValue] = useState('');
    draft = value;

    return (
      <App
        user={USER}
        currentId={id}
        onSelectConversation={setId}
        draft={value}
        onDraftChange={setValue}
        onConversationCreated={setId}
        onOpenSettings={vi.fn()}
        onOpenAdmin={vi.fn()}
        onSignOut={vi.fn()}
      />
    );
  }

  render(
    <QueryClientProvider client={createQueryClient()}>
      <Shell />
    </QueryClientProvider>
  );

  return { draft: () => draft };
}

const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send message' });

/** Attaches a file through the real input, and waits for the upload to land. */
async function attach(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');

  const file = new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' });
  await user.upload(input, file);
  await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
  await waitFor(() => expect(sendButton().disabled).toBe(false));
}

describe('sending an image with no text', () => {
  it('starts a generation carrying the attachment and no content', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    await attach(user);
    await user.click(sendButton());

    await waitFor(() => expect(startGeneration).toHaveBeenCalled());
    expect(startGeneration).toHaveBeenCalledWith('c-1', 'local', 'vision', '', [ATTACHMENT.id]);
  });

  it('sends no invented text in place of what was not typed', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    await attach(user);
    await user.click(sendButton());

    await waitFor(() => expect(startGeneration).toHaveBeenCalled());
    expect(startGeneration.mock.calls[0]?.[3]).toBe('');
  });

  it('clears the tray once the server has accepted it', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    await attach(user);
    await user.click(sendButton());

    await waitFor(() => expect(screen.queryByText('diagram.png')).toBeNull());
  });

  /*
   * A failed send must leave the reader exactly where they were: the file is
   * already on the server, and dropping the chip would mean uploading it again
   * to say the same thing.
   */
  it('keeps the attachment when starting the generation fails', async () => {
    startGeneration.mockRejectedValueOnce(new ApiError('PROVIDER_UNAVAILABLE', 'No provider.'));
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    await attach(user);
    await user.click(sendButton());

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No provider.');
    expect(screen.getByText('diagram.png')).toBeTruthy();
    // Still sendable, so the reader can simply try again.
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it('still refuses to send with neither text nor an attachment', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByLabelText('Message');

    expect(sendButton().disabled).toBe(true);
    await user.click(sendButton());

    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('still sends text with the attachment when there is text', async () => {
    const user = userEvent.setup();
    renderApp();
    const composer = await screen.findByLabelText('Message');

    await attach(user);
    await user.type(composer, 'what is this?');
    await user.click(sendButton());

    await waitFor(() => expect(startGeneration).toHaveBeenCalled());
    expect(startGeneration).toHaveBeenCalledWith('c-1', 'local', 'vision', 'what is this?', [
      ATTACHMENT.id,
    ]);
  });
});
