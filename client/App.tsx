import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@shared/conversation.ts';
import type { ModelDto } from '@shared/generation.ts';
import {
  ApiError,
  cancelGeneration,
  createConversation,
  deleteConversation,
  fetchModels,
  getConversation,
  listConversations,
  renameConversation,
  startGeneration,
  type ConversationSummary,
} from './api.ts';
import { useGeneration } from './useGeneration.ts';

/** An in-flight generation survives a reload, so its id is parked in storage. */
const ACTIVE_KEY = 'workspace.activeGeneration';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, blocked cookies); non-fatal.
  }
}

export function App(): React.JSX.Element {
  const [models, setModels] = useState<ModelDto[]>([]);
  const [model, setModel] = useState('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [generationId, setGenerationId] = useState<string | null>(() => readStored(ACTIVE_KEY));
  /** Id of the assistant message the server will append when the run settles. */
  const [awaitingMessageId, setAwaitingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = useGeneration(generationId);
  const busy = live.state === 'pending' || live.state === 'streaming';
  const outputRef = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load conversations.');
    }
  }, []);

  /**
   * Loads a conversation, optionally waiting for a message the server is still
   * appending.
   *
   * The SSE `done` event marks the end of *generation*; the assistant block is
   * written to Markdown just after that, under the conversation lock. Reloading
   * the instant `done` arrives can therefore race the write and show a
   * conversation that is missing its reply. When we know the id the server will
   * write, poll briefly for it rather than rendering a half-finished turn.
   */
  const openConversation = useCallback(async (id: string, awaitMessageId?: string) => {
    setError(null);
    setCurrentId(id);
    try {
      let detail = await getConversation(id);

      if (awaitMessageId !== undefined) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (detail.messages.some((message) => message.id === awaitMessageId)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          detail = await getConversation(id);
        }
      }

      setMessages(detail.messages);
    } catch (err) {
      setMessages([]);
      setError(
        err instanceof ApiError && err.code === 'CONVERSATION_MALFORMED'
          ? 'This conversation file cannot be read. You can still delete it.'
          : 'Could not open the conversation.'
      );
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchModels()
      .then((list) => {
        if (controller.signal.aborted) return;
        setModels(list);
        setModel((current) => current || (list.find((m) => m.loaded) ?? list[0])?.id || '');
      })
      .catch(() => setError('Could not load models.'));

    void refreshList();
    return () => controller.abort();
  }, [refreshList]);

  // When a generation settles, reload the conversation from the server rather
  // than patching local state: the Markdown is the record, and it now contains
  // the assistant message the server appended.
  useEffect(() => {
    if (generationId === null) return;
    if (live.state === 'idle' || live.state === 'pending' || live.state === 'streaming') return;

    if (live.state === 'failed' || live.state === 'timed_out') {
      setError(
        live.state === 'timed_out'
          ? 'The model provider timed out.'
          : 'The generation failed. Check the server logs.'
      );
    }

    writeStored(ACTIVE_KEY, null);
    setGenerationId(null);

    if (currentId !== null) {
      const pending = awaitingMessageId ?? undefined;
      setAwaitingMessageId(null);
      void openConversation(currentId, pending).then(() => refreshList());
    }
  }, [live.state, generationId, currentId, awaitingMessageId, openConversation, refreshList]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [live.content, live.reasoning, messages]);

  const onCreate = useCallback(async () => {
    setError(null);
    try {
      const created = await createConversation();
      setMessages([]);
      setCurrentId(created.id);
      await refreshList();
    } catch {
      setError('Could not create a conversation.');
    }
  }, [refreshList]);

  const onRename = useCallback(
    async (id: string, currentTitle: string) => {
      const next = window.prompt('Rename conversation', currentTitle);
      if (next === null || next.trim() === '') return;
      try {
        await renameConversation(id, next.trim());
        await refreshList();
      } catch {
        setError('Could not rename the conversation.');
      }
    },
    [refreshList]
  );

  const onDelete = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
      try {
        await deleteConversation(id);
        if (currentId === id) {
          setCurrentId(null);
          setMessages([]);
        }
        await refreshList();
      } catch {
        setError('Could not delete the conversation.');
      }
    },
    [currentId, refreshList]
  );

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (text === '' || model === '' || busy || currentId === null) return;

    setError(null);
    setPrompt('');
    // Shown immediately; the server has already persisted it by the time the
    // request resolves, and the reload after the generation settles replaces it.
    setMessages((prev) => [...prev, { type: 'user', id: `pending-${Date.now()}`, body: text }]);

    try {
      const accepted = await startGeneration(currentId, model, text);
      writeStored(ACTIVE_KEY, accepted.generationId);
      setAwaitingMessageId(accepted.assistantMessageId);
      setGenerationId(accepted.generationId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the generation.');
      void openConversation(currentId);
    }
  }, [prompt, model, busy, currentId, openConversation]);

  const stop = useCallback(async () => {
    if (generationId === null) return;
    try {
      await cancelGeneration(generationId);
    } catch {
      // It may have finished between render and click.
    }
  }, [generationId]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__head">
          <h1>Workspace</h1>
          <button type="button" onClick={() => void onCreate()}>
            New
          </button>
        </div>

        <ul className="conversations">
          {conversations.length === 0 && <li className="muted small">No conversations yet.</li>}
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className={`conversation${conversation.id === currentId ? ' is-current' : ''}`}
            >
              <button
                type="button"
                className="conversation__open"
                onClick={() => void openConversation(conversation.id)}
              >
                <span className="conversation__title">
                  {conversation.malformed ? '⚠ ' : ''}
                  {conversation.title}
                </span>
                <span className="conversation__meta">{conversation.messageCount} msg</span>
              </button>
              <span className="conversation__actions">
                {!conversation.malformed && (
                  <button
                    type="button"
                    className="icon"
                    title="Rename"
                    onClick={() => void onRename(conversation.id, conversation.title)}
                  >
                    ✎
                  </button>
                )}
                <button
                  type="button"
                  className="icon"
                  title="Delete"
                  onClick={() => void onDelete(conversation.id)}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <header className="bar">
          <label className="field">
            <span className="sr-only">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={models.length === 0 || busy}
            >
              {models.length === 0 && <option>Loading models…</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.loaded ? ' ●' : ''}
                </option>
              ))}
            </select>
          </label>
        </header>

        {error !== null && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <div className="output" ref={outputRef}>
          {currentId === null && (
            <p className="muted empty">Select a conversation, or create one.</p>
          )}

          {currentId !== null &&
            messages.map((message, i) => (
              <article key={`${message.id}-${i}`} className={`msg msg--${message.type}`}>
                <div className="msg__role">{message.type}</div>
                {message.type === 'assistant' && message.reasoning !== undefined && (
                  <details className="reasoning">
                    <summary>Reasoning</summary>
                    <div className="reasoning__body">{message.reasoning}</div>
                  </details>
                )}
                <div className="msg__body">{message.body}</div>
              </article>
            ))}

          {busy && (
            <article className="msg msg--assistant">
              <div className="msg__role">
                assistant
                <span className="state">{live.state}</span>
              </div>
              {live.reasoning !== '' && (
                <details className="reasoning" open>
                  <summary>Reasoning</summary>
                  <div className="reasoning__body">{live.reasoning}</div>
                </details>
              )}
              <div className="msg__body">
                {live.content}
                <span className="cursor" aria-hidden="true" />
              </div>
            </article>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={currentId === null ? 'Select a conversation first…' : 'Send a message…'}
            rows={2}
            disabled={busy || currentId === null}
          />
          {busy ? (
            <button type="button" className="danger" onClick={() => void stop()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={prompt.trim() === '' || currentId === null}>
              Send
            </button>
          )}
        </form>
      </main>
    </div>
  );
}
