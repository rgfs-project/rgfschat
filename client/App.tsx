import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ModelDto } from '@shared/generation.ts';
import { ApiError, cancelGeneration, fetchModels, startGeneration } from './api.ts';
import { useGeneration } from './useGeneration.ts';

type ModelsState =
  | { status: 'loading' }
  | { status: 'ready'; models: ModelDto[] }
  | { status: 'error'; message: string };

/** Generations survive a reload, so the id is parked where a reload can find it. */
const ACTIVE_KEY = 'workspace.activeGeneration';

function readActive(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActive(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_KEY);
    else window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // Storage unavailable (private mode, blocked cookies); non-fatal.
  }
}

export function App(): React.JSX.Element {
  const [models, setModels] = useState<ModelsState>({ status: 'loading' });
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [generationId, setGenerationId] = useState<string | null>(() => readActive());
  const [error, setError] = useState<string | null>(null);

  const live = useGeneration(generationId);
  const busy = live.state === 'pending' || live.state === 'streaming';
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchModels()
      .then((list) => {
        if (controller.signal.aborted) return;
        setModels({ status: 'ready', models: list });
        setModel((current) => current || (list.find((m) => m.loaded) ?? list[0])?.id || '');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setModels({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Could not load models.',
        });
      });

    return () => controller.abort();
  }, []);

  // Once a generation reaches a terminal state, fold its output into the
  // transcript and stop tracking it.
  useEffect(() => {
    if (generationId === null) return;
    if (live.state === 'idle' || live.state === 'pending' || live.state === 'streaming') return;

    if (live.content !== '') {
      setTranscript((prev) => [...prev, { role: 'assistant', content: live.content }]);
    } else if (live.state === 'completed' && live.reasoning !== '') {
      // Observed with gpt-oss: the whole output budget can be spent on
      // reasoning, finishing cleanly with no content at all. Silently showing
      // nothing looks like a bug, so name the cause.
      setError('The model used its entire output budget on reasoning. Raise MAX_OUTPUT_TOKENS.');
    }
    if (live.state === 'failed' || live.state === 'timed_out') {
      setError(
        live.state === 'timed_out'
          ? 'The model provider timed out.'
          : 'The generation failed. Check the server logs.'
      );
    }
    writeActive(null);
    setGenerationId(null);
  }, [live.state, live.content, live.reasoning, generationId]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [live.content, live.reasoning, transcript]);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (text === '' || model === '' || busy) return;

    setError(null);
    const next: ChatMessage[] = [...transcript, { role: 'user', content: text }];
    setTranscript(next);
    setPrompt('');

    try {
      const { generationId: id } = await startGeneration(model, next);
      writeActive(id);
      setGenerationId(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the generation.');
    }
  }, [prompt, model, busy, transcript]);

  const stop = useCallback(async () => {
    if (generationId === null) return;
    try {
      await cancelGeneration(generationId);
    } catch {
      // The generation may have finished between render and click.
    }
  }, [generationId]);

  const modelOptions = useMemo(() => (models.status === 'ready' ? models.models : []), [models]);

  return (
    <main className="app">
      <header className="bar">
        <h1>Workspace</h1>
        <label className="field">
          <span className="sr-only">Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={models.status !== 'ready' || busy}
          >
            {models.status === 'loading' && <option>Loading models…</option>}
            {models.status === 'error' && <option>Unavailable</option>}
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.loaded ? ' ●' : ''}
              </option>
            ))}
          </select>
        </label>
      </header>

      {models.status === 'error' && (
        <p role="alert" className="error">
          {models.message}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="output" ref={outputRef}>
        {transcript.length === 0 && !busy && (
          <p className="muted empty">Pick a model and send a message.</p>
        )}

        {transcript.map((message, i) => (
          <article key={i} className={`msg msg--${message.role}`}>
            <div className="msg__role">{message.role}</div>
            <div className="msg__body">{message.content}</div>
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
          placeholder="Send a message…"
          rows={2}
          disabled={busy}
        />
        {busy ? (
          <button type="button" className="danger" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={prompt.trim() === '' || model === ''}>
            Send
          </button>
        )}
      </form>
    </main>
  );
}
