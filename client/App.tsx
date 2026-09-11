import { useCallback, useEffect, useState } from 'react';
import type { HealthDto } from '@shared/api.ts';
import { ApiError, fetchHealth } from './api.ts';

type State =
  | { status: 'loading' }
  | { status: 'ready'; health: HealthDto }
  | { status: 'error'; message: string };

export function App(): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback((signal?: AbortSignal) => {
    setState({ status: 'loading' });

    fetchHealth()
      .then((health) => {
        if (signal?.aborted === true) return;
        setState({ status: 'ready', health });
      })
      .catch((err: unknown) => {
        if (signal?.aborted === true) return;
        const message =
          err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
        setState({ status: 'error', message });
      });
  }, []);

  // An AbortController (rather than a "run once" ref) keeps this correct under
  // React Strict Mode's double-invoked effects.
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main className="app">
      <h1>Workspace</h1>
      <section className="card" aria-live="polite">
        <h2>Server health</h2>

        {state.status === 'loading' && <p className="muted">Checking…</p>}

        {state.status === 'ready' && (
          <dl className="health">
            <dt>Status</dt>
            <dd>
              <span className="badge badge--ok">{state.health.status}</span>
            </dd>
            <dt>Version</dt>
            <dd>{state.health.version}</dd>
          </dl>
        )}

        {state.status === 'error' && (
          <>
            <p role="alert" className="error">
              {state.message}
            </p>
            <button type="button" onClick={() => load()}>
              Retry
            </button>
          </>
        )}
      </section>
    </main>
  );
}
