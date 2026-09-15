import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';
import { stubScrollGeometry } from './test-setup.ts';

/**
 * A conversation change starts over.
 *
 * The transcript's scroll state describes one conversation: whether the reader
 * had scrolled away from its bottom, whether it overflows at all, where we last
 * put it. Opening another one makes all of that false, and the visible symptom
 * was a jump-to-latest arrow — left over from a long chat the reader had
 * scrolled up in — hanging over an empty New chat with nothing to jump to.
 */

type Api = typeof ApiModule;

const listConversations = vi.fn<Api['listConversations']>();
const getConversation = vi.fn<Api['getConversation']>();
const fetchModels = vi.fn<Api['fetchModels']>();
const fetchMyPreferences = vi.fn<Api['fetchMyPreferences']>();
const fetchProposals = vi.fn<Api['fetchProposals']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    listConversations,
    getConversation,
    fetchModels,
    fetchMyPreferences,
    fetchProposals,
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
const VIEWPORT = 500;

const summary = (id: string, title: string) => ({
  id,
  title,
  createdAt: NOW,
  updatedAt: NOW,
  messageCount: 2,
  malformed: false,
});

/** A conversation with `count` exchanges in it. */
const detail = (id: string, count: number) => ({
  id,
  title: id,
  createdAt: NOW,
  updatedAt: NOW,
  messages: Array.from({ length: count }, (_, index) => ({
    id: `${id}-m${index}`,
    type: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    body: `Message ${index} in ${id}`,
    createdAt: NOW,
    ...(index % 2 === 0 ? { attachments: [] } : { status: 'complete' as const }),
  })),
  activeGenerationId: null,
});

beforeEach(() => {
  localStorage.clear();
  listConversations.mockResolvedValue([
    summary('long-chat', 'Long chat'),
    summary('short', 'Short'),
  ]);
  fetchModels.mockResolvedValue({
    providers: [
      {
        providerId: 'local',
        providerName: 'Local',
        status: 'ready',
        models: [{ id: 'gpt', loaded: true, inputModalities: ['text'] }],
      },
    ],
    defaultModel: null,
  } as unknown as Awaited<ReturnType<Api['fetchModels']>>);
  fetchMyPreferences.mockResolvedValue({ pinned: [], defaultModel: null } as unknown as Awaited<
    ReturnType<Api['fetchMyPreferences']>
  >);
  fetchProposals.mockResolvedValue([]);
  getConversation.mockImplementation((id) =>
    Promise.resolve(
      detail(id, id === 'long-chat' ? 20 : 2) as unknown as Awaited<
        ReturnType<Api['getConversation']>
      >
    )
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

interface Harness {
  open: (id: string | null) => Promise<void>;
  geometry: ReturnType<typeof stubScrollGeometry>;
  transcript: HTMLElement;
}

async function renderApp(startAt: string, contentHeight = 4_000): Promise<Harness> {
  let select: (id: string | null) => void = () => {};

  function Shell(): React.JSX.Element {
    const [id, setId] = useState<string | null>(startAt);
    const [draft, setDraft] = useState('');
    select = setId;

    return (
      <App
        user={USER}
        currentId={id}
        onSelectConversation={setId}
        draft={draft}
        onDraftChange={setDraft}
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

  await screen.findByText(`Message 0 in ${startAt}`);
  const transcript = screen.getByTestId('transcript');
  freezeLayout(transcript);
  const geometry = stubScrollGeometry(transcript, {
    scrollHeight: contentHeight,
    clientHeight: VIEWPORT,
    scrollTop: contentHeight - VIEWPORT,
  });

  return {
    transcript,
    geometry,
    open: async (id) => {
      act(() => select(id));
      if (id !== null) await screen.findByText(`Message 0 in ${id}`);
      else await waitFor(() => expect(screen.queryByText(/^Message 0 in/)).toBeNull());
      freezeLayout(transcript);
    },
  };
}

/**
 * Gives the transcript a settled layout.
 *
 * jsdom measures everything as zero, and the tail reserve is computed from the
 * distance between two boxes — with both at zero it asks for a spacer, which
 * changes the boxes it measures next, and the measurement never settles. Real
 * geometry is what a browser supplies; here it is stated: the content is taller
 * than the viewport, so the reserve is zero and stays there, which is the state
 * this file is about anyway.
 */
function freezeLayout(transcript: HTMLElement): void {
  const inner = transcript.querySelector('.transcript__inner');
  if (inner !== null) {
    inner.getBoundingClientRect = () => ({ top: 0, bottom: 5_000 }) as DOMRect;
  }
  for (const message of transcript.querySelectorAll('[data-message-id]')) {
    message.getBoundingClientRect = () => ({ top: 0, bottom: 0 }) as DOMRect;
  }
}

/**
 * Scrolls the transcript the way the reader would, away from the bottom.
 *
 * Not to zero: a position this hook has itself scrolled to is recognised as
 * its own and carries no intent, and on an unmeasured transcript that position
 * is zero. Partway up is what a reader reading back actually does.
 */
function scrollAway(harness: Harness, top = 200): void {
  act(() => {
    harness.geometry.set({ scrollTop: top });
    harness.transcript.dispatchEvent(new Event('scroll'));
  });
}

const jumpButton = () => screen.queryByRole('button', { name: 'Jump to latest' });

describe('jump to latest, across a conversation change', () => {
  it('is offered in a long conversation the reader has scrolled up in', async () => {
    const harness = await renderApp('long-chat');

    scrollAway(harness);

    expect(jumpButton()).not.toBeNull();
  });

  /* The reported sequence, exactly: scroll up, then New chat. */
  it('is gone on the empty New chat screen', async () => {
    const harness = await renderApp('long-chat');
    scrollAway(harness);
    expect(jumpButton()).not.toBeNull();

    // New chat: no messages, nothing to scroll, nothing to jump to.
    harness.geometry.set({ scrollHeight: VIEWPORT, scrollTop: 0 });
    await harness.open(null);

    expect(jumpButton()).toBeNull();
  });

  it('is gone in a short conversation that does not scroll', async () => {
    const harness = await renderApp('long-chat');
    scrollAway(harness);

    harness.geometry.set({ scrollHeight: VIEWPORT - 100, scrollTop: 0 });
    await harness.open('short');

    expect(jumpButton()).toBeNull();
  });

  it('comes back on returning to the long conversation and scrolling up again', async () => {
    const harness = await renderApp('long-chat');
    scrollAway(harness);

    harness.geometry.set({ scrollHeight: VIEWPORT, scrollTop: 0 });
    await harness.open('short');
    expect(jumpButton()).toBeNull();

    harness.geometry.set({ scrollHeight: 4_000, scrollTop: 4_000 - VIEWPORT });
    await harness.open('long-chat');
    // Back at the bottom: following again, with nothing to offer yet.
    expect(jumpButton()).toBeNull();

    scrollAway(harness);
    expect(jumpButton()).not.toBeNull();
  });

  it('survives rapid switching without inheriting either transcript’s state', async () => {
    const harness = await renderApp('long-chat');
    scrollAway(harness);

    for (const [id, height] of [
      ['short', VIEWPORT - 100],
      ['long-chat', 4_000],
      ['short', VIEWPORT - 100],
    ] as const) {
      harness.geometry.set({ scrollHeight: height, scrollTop: 0 });
      await harness.open(id);
    }

    expect(jumpButton()).toBeNull();
  });
});
