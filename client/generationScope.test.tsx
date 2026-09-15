import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@shared/auth';
import type * as ApiModule from './api.ts';

/**
 * A generation belongs to a conversation, and so does everything it draws.
 *
 * A run is server-owned and survives the view (INV-06): opening another chat
 * does not stop it, and should not. What went wrong was the other half — the
 * client held "the generation" as a bare id with no conversation attached, so
 * every question about it ("are we busy?", "what has arrived?") was answered in
 * whichever transcript happened to be open. Chat B showed chat A's three dots,
 * A's cursor, A's reasoning and A's partial reply, and reserved empty space
 * under B's last message for an answer that was never coming to B.
 *
 * So: start a generation in A, leave for B before the first token and again
 * after partial content, and assert B shows none of it — while A keeps running
 * and still has all of it when the reader comes back.
 */

type Api = typeof ApiModule;

const listConversations = vi.fn<Api['listConversations']>();
const getConversation = vi.fn<Api['getConversation']>();
const fetchModels = vi.fn<Api['fetchModels']>();
const fetchMyPreferences = vi.fn<Api['fetchMyPreferences']>();
const fetchProposals = vi.fn<Api['fetchProposals']>();
const startGeneration = vi.fn<Api['startGeneration']>();

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<Api>('./api.ts');
  return {
    ...actual,
    listConversations,
    getConversation,
    fetchModels,
    fetchMyPreferences,
    fetchProposals,
    startGeneration,
  };
});

const { App } = await import('./App.tsx');
const { createQueryClient } = await import('./queries.ts');

/* --- a controllable EventSource ------------------------------------------ */

interface FakeSource {
  url: string;
  isClosed: () => boolean;
  emit: (name: string, data: unknown) => void;
}

const sources: FakeSource[] = [];

/**
 * An `EventSource` the test drives by hand.
 *
 * jsdom has none, and the point of these tests is the order of events against
 * a conversation change — which needs the stream held open and released a
 * token at a time, not a transport.
 */
class TestEventSource {
  readonly url: string;
  closed = false;
  onerror: (() => void) | null = null;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    sources.push({
      url,
      isClosed: () => this.closed,
      emit: (name, data) => {
        const event = new MessageEvent(name, { data: JSON.stringify(data), lastEventId: '1' });
        for (const listener of this.#listeners.get(name) ?? []) listener(event);
      },
    });
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.#listeners.get(name);
    if (existing === undefined) this.#listeners.set(name, [listener]);
    else existing.push(listener);
  }

  removeEventListener(): void {}

  close(): void {
    this.closed = true;
  }
}

/** The stream for a generation id, whether or not it is still attached. */
function streamFor(generationId: string): FakeSource {
  const source = sources.findLast((candidate) => candidate.url.includes(generationId));
  if (source === undefined) throw new Error(`No stream opened for ${generationId}`);
  return source;
}

function emit(generationId: string, name: string, data: unknown): void {
  act(() => {
    streamFor(generationId).emit(name, data);
  });
}

/* --- the two conversations ------------------------------------------------ */

const USER: UserDto = {
  id: 'u-1',
  username: 'tester',
  role: 'user',
  status: 'active',
  createdAt: new Date().toISOString(),
};

const NOW = new Date().toISOString();

const SUMMARY = (id: string, title: string) => ({
  id,
  title,
  createdAt: NOW,
  updatedAt: NOW,
  messageCount: 1,
  malformed: false,
});

const DETAIL = (id: string, body: string) => ({
  id,
  title: id === 'chat-a' ? 'Chat A' : 'Chat B',
  createdAt: NOW,
  updatedAt: NOW,
  messages: [{ id: `${id}-m1`, type: 'user' as const, body, createdAt: NOW, attachments: [] }],
  activeGenerationId: null,
});

beforeEach(() => {
  sources.length = 0;
  // The parked generation outlives a reload by design, and would otherwise
  // outlive a test: each one starts with nothing running anywhere.
  localStorage.clear();
  vi.stubGlobal('EventSource', TestEventSource);

  listConversations.mockResolvedValue([SUMMARY('chat-a', 'Chat A'), SUMMARY('chat-b', 'Chat B')]);
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
  fetchMyPreferences.mockResolvedValue({
    pinned: [],
    defaultModel: null,
  } as unknown as Awaited<ReturnType<Api['fetchMyPreferences']>>);
  fetchProposals.mockResolvedValue([]);
  getConversation.mockImplementation((id) =>
    Promise.resolve(
      DETAIL(id, id === 'chat-a' ? 'Ask A' : 'Ask B') as unknown as Awaited<
        ReturnType<Api['getConversation']>
      >
    )
  );
  startGeneration.mockResolvedValue({
    generationId: 'gen-a',
    userMessageId: 'u-new',
    assistantMessageId: 'a-new',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

interface Harness {
  open: (id: string) => Promise<void>;
  currentId: () => string | null;
}

function renderApp(startAt: string): Harness {
  let select: (id: string | null) => void = () => {};
  let current: string | null = startAt;

  function Shell(): React.JSX.Element {
    const [id, setId] = useState<string | null>(startAt);
    const [draft, setDraft] = useState('');
    select = (next) => {
      current = next;
      setId(next);
    };

    return (
      <App
        user={USER}
        currentId={id}
        onSelectConversation={select}
        draft={draft}
        onDraftChange={setDraft}
        onConversationCreated={select}
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

  return {
    open: async (id) => {
      act(() => select(id));
      await screen.findByText(id === 'chat-a' ? 'Ask A' : 'Ask B');
    },
    currentId: () => current,
  };
}

/** Everything a running generation puts on screen, asked of the DOM. */
function rendered(): {
  dots: boolean;
  cursor: boolean;
  streamingBlock: boolean;
  reasoning: boolean;
  tailSpace: string;
} {
  const container = document.body;
  return {
    dots: container.querySelector('.thinking') !== null,
    cursor: container.querySelector('.cursor') !== null,
    streamingBlock: container.querySelector('.msg--streaming') !== null,
    reasoning: container.querySelector('.reasoning') !== null,
    tailSpace:
      (container.querySelector<HTMLElement>('.transcript__tail')?.style.height ?? '') || '',
  };
}

async function sendFromA(): Promise<void> {
  const user = userEvent.setup();
  const composer = await screen.findByLabelText<HTMLTextAreaElement>('Message');
  await user.type(composer, 'Hello');
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(startGeneration).toHaveBeenCalled());
  await screen.findByLabelText(/Assistant is/);
}

describe('a generation running in another conversation', () => {
  it('shows its dots in the chat that asked', async () => {
    renderApp('chat-a');
    await sendFromA();

    expect(rendered().dots).toBe(true);
  });

  it('shows nothing of itself in a chat opened before the first token', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();

    await harness.open('chat-b');

    expect(rendered()).toMatchObject({
      dots: false,
      cursor: false,
      streamingBlock: false,
      reasoning: false,
    });
  });

  it('reserves no empty space under the other chat’s last message', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();

    await harness.open('chat-b');

    // The reserve exists to put a question at the top of the screen while its
    // answer arrives. No answer is coming here, so it holds nothing open.
    expect(['', '0px']).toContain(rendered().tailSpace);
  });

  it('shows nothing of itself in a chat opened after partial content', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();

    emit('gen-a', 'state', { type: 'state', state: 'streaming' });
    emit('gen-a', 'reasoning', { type: 'reasoning', delta: 'Working it out' });
    emit('gen-a', 'content', { type: 'content', delta: 'Half an answer' });

    await harness.open('chat-b');

    expect(rendered()).toMatchObject({
      dots: false,
      cursor: false,
      streamingBlock: false,
      reasoning: false,
    });
    expect(screen.queryByText(/Half an answer/)).toBeNull();
    expect(screen.queryByText(/Working it out/)).toBeNull();
  });

  it('keeps streaming into the chat that asked while another is open', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();
    await harness.open('chat-b');

    emit('gen-a', 'content', { type: 'content', delta: 'Arrived while away' });

    // The observation channel is still attached — leaving does not cancel.
    expect(streamFor('gen-a').isClosed()).toBe(false);
    expect(screen.queryByText(/Arrived while away/)).toBeNull();
  });

  it('shows the whole partial answer again on returning to it', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();

    emit('gen-a', 'content', { type: 'content', delta: 'Half an answer' });
    await harness.open('chat-b');
    emit('gen-a', 'content', { type: 'content', delta: ', and the rest' });

    await harness.open('chat-a');

    expect(await screen.findByText(/Half an answer, and the rest/)).toBeTruthy();
    expect(rendered().cursor).toBe(true);
  });

  it('announces nothing to a screen reader in the chat that did not ask', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();

    await harness.open('chat-b');

    const live = document.body.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('');
  });
});

describe('a generation finishing while another conversation is open', () => {
  it('leaves the open conversation exactly as it was', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();
    await harness.open('chat-b');

    emit('gen-a', 'done', { type: 'done', state: 'completed' });

    expect(rendered()).toMatchObject({ dots: false, cursor: false, streamingBlock: false });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('raises no error banner over a conversation the failure was not in', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();
    await harness.open('chat-b');

    emit('gen-a', 'done', { type: 'done', state: 'failed', errorCode: 'PROVIDER_ERROR' });

    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rendered().streamingBlock).toBe(false);
  });

  /*
   * Invalidating the open conversation because a different one finished is
   * both a wasted request and a way for A's terminal event to change what B is
   * showing — the refetch lands in B's transcript.
   */
  it('does not refetch the conversation on screen', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();
    await harness.open('chat-b');
    getConversation.mockClear();

    emit('gen-a', 'done', { type: 'done', state: 'completed' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getConversation.mock.calls.map(([id]) => id)).not.toContain('chat-b');
  });

  /* A's own transcript is stale after its run, so returning to it reads the
     persisted reply rather than showing the pre-generation messages. */
  it('refetches the conversation it belongs to when the reader returns', async () => {
    const harness = renderApp('chat-a');
    await sendFromA();
    await harness.open('chat-b');

    emit('gen-a', 'done', { type: 'done', state: 'completed' });
    getConversation.mockClear();
    await harness.open('chat-a');

    await waitFor(() => expect(getConversation.mock.calls.map(([id]) => id)).toContain('chat-a'));
  });

  it('still reports a failure in the conversation it happened in', async () => {
    renderApp('chat-a');
    await sendFromA();

    emit('gen-a', 'done', { type: 'done', state: 'failed', errorCode: 'PROVIDER_ERROR' });

    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
