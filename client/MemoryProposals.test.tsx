import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryProposalDto } from './api.ts';
import { MemoryProposals } from './MemoryProposals.tsx';
import { createQueryClient } from './queries.ts';

/**
 * The confirmation step, from the reader's side.
 *
 * What is being checked is mostly *wording*: nothing has been written while one
 * of these is on screen, and a card that implied otherwise would undo the point
 * of having it. The rest is that accept and reject reach the server as
 * different requests — the whole mechanism is one boolean, and getting it
 * backwards would silently save every note a reader turned down.
 */

const CONVERSATION = '22222222-2222-4222-8222-222222222222';

const PROPOSAL: MemoryProposalDto = {
  id: '44444444-4444-4444-8444-444444444444',
  assistantMessageId: '33333333-3333-4333-8333-333333333333',
  operation: 'create',
  name: 'coffee-order',
  content: 'Drinks flat whites.',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ applied: true }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * A deletion carries no content at all, rather than a `content: undefined`.
 * Under `exactOptionalPropertyTypes` those are different types, and the server
 * sends the former.
 */
function deletion(overrides: Partial<MemoryProposalDto> = {}): MemoryProposalDto {
  const rest = { ...PROPOSAL };
  delete rest.content;
  return { ...rest, operation: 'delete', ...overrides };
}

function setup(proposals: MemoryProposalDto[] = [PROPOSAL]) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryProposals conversationId={CONVERSATION} proposals={proposals} />
    </QueryClientProvider>
  );
}

/** The body of the one request that was sent. */
function sentBody(): { accept: boolean } {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as { accept: boolean };
}

describe('MemoryProposals', () => {
  it('renders nothing when there is nothing pending', () => {
    const { container } = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryProposals conversationId={CONVERSATION} proposals={[]} />
      </QueryClientProvider>
    );

    expect(container.firstChild).toBeNull();
  });

  /* The note as it would be saved, so what is agreed to is what is shown. */
  it('shows the name and the note', () => {
    setup();

    expect(screen.getByText('coffee-order')).toBeTruthy();
    expect(screen.getByText('Drinks flat whites.')).toBeTruthy();
  });

  it('says the model wants to, not that it has', () => {
    setup();

    expect(screen.getByText(/wants to remember/i)).toBeTruthy();
    expect(screen.queryByText(/saved|remembered it|has remembered/i)).toBeNull();
  });

  it('words an update and a deletion differently', () => {
    setup([{ ...PROPOSAL, operation: 'update' }, deletion({ id: 'b' })]);

    expect(screen.getByText(/wants to update/i)).toBeTruthy();
    expect(screen.getByText(/wants to forget/i)).toBeTruthy();
  });

  /* A deletion has no content, and rendering an empty paragraph for it would
     leave a card with a blank line where the note should be. */
  it('shows no note body for a deletion', () => {
    setup([deletion()]);

    expect(screen.queryByText('Drinks flat whites.')).toBeNull();
  });

  it('sends accept: true when accepted', async () => {
    setup();

    await userEvent.click(screen.getByRole('button', { name: /^Accept/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(sentBody()).toEqual({ accept: true });
  });

  it('sends accept: false when rejected', async () => {
    setup();

    await userEvent.click(screen.getByRole('button', { name: /^Reject/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(sentBody()).toEqual({ accept: false });
  });

  it('addresses the proposal it was shown', async () => {
    setup();

    await userEvent.click(screen.getByRole('button', { name: /^Accept/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(CONVERSATION);
    expect(url).toContain(PROPOSAL.id);
  });

  /* Each card answers for itself: a reader with three pending notes should be
     able to take one and leave the others. */
  it('names each proposal in its controls, so two cards are distinguishable', () => {
    setup([PROPOSAL, { ...PROPOSAL, id: 'b', name: 'employer' }]);

    expect(screen.getByRole('button', { name: /Accept.*coffee-order/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accept.*employer/ })).toBeTruthy();
  });
});
