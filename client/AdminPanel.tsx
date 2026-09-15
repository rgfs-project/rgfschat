import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Database,
  Eye,
  EyeOff,
  Plug,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { UserDto } from '@shared/auth';
import {
  ApiError,
  createAdminProvider,
  createAdminUser,
  deleteAdminProvider,
  deleteAdminUser,
  fetchAdminProviders,
  fetchAdminSettings,
  fetchAdminUsers,
  clearAdminHistory,
  rebuildAdminIndex,
  refreshAdminModels,
  setAdminUserPassword,
  testAdminProvider,
  updateAdminProvider,
  updateAdminSettings,
  updateAdminUser,
  type AdminProviderDto,
  type ProviderWrite,
} from './api.ts';
import { Dialog } from './Dialog.tsx';
import { SamplerPanel } from './SamplerPanel.tsx';
import { ModelSelect } from './ModelSelect.tsx';
import { Select } from './Select.tsx';
import { keys, useModels } from './queries.ts';

/**
 * Administration.
 *
 * A modal over the application rather than a separate page: an operator is
 * usually here to change one thing and go back to what they were doing, and
 * losing the open conversation to do it is a worse trade than the space a
 * dialog costs.
 *
 * Everything shown here is also enforced on the server. Hiding a control for a
 * non-admin is a courtesy; `requireAdmin` is the actual boundary (INV-24).
 */

type Section = 'users' | 'providers' | 'models' | 'sampler' | 'settings' | 'maintenance';

const SECTIONS: { id: Section; label: string; icon: typeof Users }[] = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'models', label: 'Models', icon: Eye },
  { id: 'sampler', label: 'Sampler', icon: SlidersHorizontal },
  { id: 'settings', label: 'Settings', icon: Settings2 },
  { id: 'maintenance', label: 'Maintenance', icon: Database },
];

export function AdminPanel({
  user,
  onClose,
}: {
  user: UserDto;
  onClose: () => void;
}): React.JSX.Element {
  const [section, setSection] = useState<Section>('users');

  return createPortal(
    <div
      className="panel"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel__card" role="dialog" aria-modal="true" aria-label="Administration">
        <nav className="panel__rail" aria-label="Admin sections">
          <button
            type="button"
            className="icon-button panel__close"
            onClick={onClose}
            aria-label="Close administration"
          >
            <X size={18} />
          </button>

          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`panel__rail-item${section === id ? ' is-current' : ''}`}
              onClick={() => setSection(id)}
              aria-current={section === id}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>

        <div className="panel__pane">
          <h2 className="panel__title">{SECTIONS.find((s) => s.id === section)?.label}</h2>
          {section === 'users' && <UsersSection currentUser={user} />}
          {section === 'providers' && <ProvidersSection />}
          {section === 'models' && <ModelsSection />}
          {section === 'sampler' && <SamplerSection />}
          {section === 'settings' && <SettingsSection />}
          {section === 'maintenance' && <MaintenanceSection currentUser={user} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** One label/control row with a hairline rule, the unit the whole pane is built from. */
function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="panel__row">
      <div className="panel__row-text">
        <span className="panel__row-label">{label}</span>
        {description !== undefined && <p className="panel__row-desc">{description}</p>}
      </div>
      <div className="panel__row-control">{children}</div>
    </div>
  );
}

function useErrorMessage(): [string | null, (err: unknown) => void, () => void] {
  const [message, setMessage] = useState<string | null>(null);
  return [
    message,
    (err: unknown) => setMessage(err instanceof ApiError ? err.message : 'Something went wrong.'),
    () => setMessage(null),
  ];
}

function Problem({ message }: { message: string | null }): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <p role="alert" className="error-banner">
      {message}
    </p>
  );
}

/* --- users ---------------------------------------------------------------- */

/** A destructive or credential-changing step awaiting confirmation. */
type UserPrompt =
  | { kind: 'password'; id: string; username: string }
  | { kind: 'delete'; id: string; username: string };

function UsersSection({ currentUser }: { currentUser: UserDto }): React.JSX.Element {
  const client = useQueryClient();
  const [error, fail, clear] = useErrorMessage();
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [prompt, setPrompt] = useState<UserPrompt | null>(null);

  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => fetchAdminUsers(signal),
  });

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['admin', 'users'] });
  };

  const create = useMutation({
    mutationFn: () => createAdminUser({ username: username.trim(), password }),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      setCreating(false);
      clear();
      invalidate();
    },
    onError: fail,
  });

  const update = useMutation({
    mutationFn: (vars: {
      id: string;
      changes: { role?: 'user' | 'admin'; status?: 'active' | 'disabled' };
    }) => updateAdminUser(vars.id, vars.changes),
    onSuccess: () => {
      clear();
      invalidate();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (vars: { id: string; username: string }) => deleteAdminUser(vars.id, vars.username),
    onSuccess: () => {
      clear();
      invalidate();
    },
    onError: fail,
  });

  const resetPassword = useMutation({
    mutationFn: (vars: { id: string; password: string }) =>
      setAdminUserPassword(vars.id, vars.password),
    onSuccess: () => clear(),
    onError: fail,
  });

  return (
    <>
      <Problem message={error} />

      {users.data?.map((account) => (
        <Row
          key={account.id}
          label={account.username}
          description={`${account.role} · ${account.status} · ${account.conversationCount} conversation${
            account.conversationCount === 1 ? '' : 's'
          }`}
        >
          <Select
            label={`Role for ${account.username}`}
            value={account.role}
            options={[
              { value: 'user', label: 'user' },
              { value: 'admin', label: 'admin' },
            ]}
            onChange={(next) =>
              update.mutate({ id: account.id, changes: { role: next as 'user' | 'admin' } })
            }
          />

          <Select
            label={`Status for ${account.username}`}
            value={account.status}
            options={[
              { value: 'active', label: 'active' },
              { value: 'disabled', label: 'disabled' },
            ]}
            onChange={(next) =>
              update.mutate({
                id: account.id,
                changes: { status: next as 'active' | 'disabled' },
              })
            }
          />

          <button
            type="button"
            className="icon-button"
            aria-label={`Set a new password for ${account.username}`}
            title="Set a new password"
            onClick={() =>
              setPrompt({ kind: 'password', id: account.id, username: account.username })
            }
          >
            <RefreshCw size={15} />
          </button>

          <button
            type="button"
            className="icon-button"
            aria-label={`Delete ${account.username}`}
            title="Delete"
            disabled={account.id === currentUser.id}
            onClick={() =>
              setPrompt({ kind: 'delete', id: account.id, username: account.username })
            }
          >
            <Trash2 size={15} />
          </button>
        </Row>
      ))}

      {prompt !== null && (
        <Dialog
          title={
            prompt.kind === 'password'
              ? `New password for ${prompt.username}`
              : `Delete ${prompt.username}?`
          }
          body={
            prompt.kind === 'password'
              ? 'Every session they have open is signed out.'
              : 'Their account and everything they own is removed. Type their username to confirm.'
          }
          defaultValue=""
          fieldLabel={prompt.kind === 'password' ? 'Password' : 'Username'}
          confirmLabel={prompt.kind === 'password' ? 'Set password' : 'Delete'}
          destructive={prompt.kind === 'delete'}
          onCancel={() => setPrompt(null)}
          onConfirm={(value) => {
            const pending = prompt;
            setPrompt(null);
            if (pending.kind === 'password') {
              resetPassword.mutate({ id: pending.id, password: value });
              return;
            }
            // Typing the name is the server's confirmation too; requiring it
            // here as well keeps the destructive step deliberate on both sides.
            if (value === pending.username) {
              remove.mutate({ id: pending.id, username: value });
            } else {
              fail(new Error('The typed username does not match.'));
            }
          }}
        />
      )}

      {creating ? (
        <form
          className="panel__form"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label className="field">
            <span>Initial password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>
          <div className="panel__form-actions">
            <button type="button" className="linkish" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" className="button-primary">
              Create user
            </button>
          </div>
        </form>
      ) : (
        <div className="panel__actions">
          <button type="button" className="button-primary" onClick={() => setCreating(true)}>
            Add a user
          </button>
        </div>
      )}
    </>
  );
}

/* --- providers ------------------------------------------------------------ */

const EMPTY_PROVIDER: ProviderWrite = {
  name: '',
  kind: 'openai-compatible',
  baseUrl: '',
  timeoutMs: 120_000,
};

function ProvidersSection(): React.JSX.Element {
  const client = useQueryClient();
  const [error, fail, clear] = useErrorMessage();
  const [draft, setDraft] = useState<ProviderWrite | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const providers = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: ({ signal }) => fetchAdminProviders(signal),
  });

  const done = (): void => {
    setDraft(null);
    setEditingId(null);
    clear();
    void client.invalidateQueries({ queryKey: ['admin', 'providers'] });
    void client.invalidateQueries({ queryKey: keys.models() });
  };

  const save = useMutation({
    mutationFn: (body: ProviderWrite) =>
      editingId === null ? createAdminProvider(body) : updateAdminProvider(editingId, body),
    onSuccess: done,
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteAdminProvider(id),
    onSuccess: done,
    onError: fail,
  });

  const test = useMutation({
    mutationFn: (body: { baseUrl: string; apiKey?: string }) => testAdminProvider(body),
    onSuccess: (result) =>
      setTestResult(
        result.ok
          ? `Reached it — ${result.modelCount ?? 0} model(s).`
          : (result.message ?? 'Could not reach it.')
      ),
    onError: fail,
  });

  function beginEdit(provider: AdminProviderDto): void {
    setEditingId(provider.id);
    setTestResult(null);
    setDraft({
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      timeoutMs: provider.timeoutMs,
    });
  }

  return (
    <>
      <Problem message={error} />

      {providers.data?.map((provider) => (
        <Row
          key={provider.id}
          label={provider.name}
          description={`${provider.baseUrl} · ${provider.hasApiKey ? 'key set' : 'no key'}`}
        >
          <button type="button" className="linkish" onClick={() => beginEdit(provider)}>
            Edit
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Delete ${provider.name}`}
            title="Delete"
            onClick={() => remove.mutate(provider.id)}
          >
            <Trash2 size={15} />
          </button>
        </Row>
      ))}

      {draft === null ? (
        <div className="panel__actions">
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              setEditingId(null);
              setTestResult(null);
              setDraft({ ...EMPTY_PROVIDER });
            }}
          >
            Add a provider
          </button>
        </div>
      ) : (
        <form
          className="panel__form"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft);
          }}
        >
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="http://127.0.0.1:8080"
              required
            />
          </label>
          <label className="field">
            <span>
              API key{' '}
              <span className="muted">
                {editingId === null ? '(optional)' : '(leave blank to keep the stored key)'}
              </span>
            </span>
            <input
              type="password"
              value={draft.apiKey ?? ''}
              onChange={(e) => {
                // Omitted entirely when blank: under `exactOptionalPropertyTypes`
                // an explicit `undefined` is not the same as an absent key, and
                // the server reads absence as "keep the stored credential".
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { apiKey: _blank, ...rest } = draft;
                setDraft(e.target.value === '' ? rest : { ...rest, apiKey: e.target.value });
              }}
            />
          </label>

          {testResult !== null && <p className="muted small">{testResult}</p>}

          <div className="panel__form-actions">
            <button type="button" className="linkish" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() =>
                test.mutate({
                  baseUrl: draft.baseUrl,
                  ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
                })
              }
            >
              Test connection
            </button>
            <button type="submit" className="button-primary">
              {editingId === null ? 'Add provider' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

/* --- models --------------------------------------------------------------- */

function ModelsSection(): React.JSX.Element {
  const client = useQueryClient();
  const [error, fail, clear] = useErrorMessage();
  const models = useModels(true);

  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => fetchAdminSettings(signal),
  });

  const hidden = new Set(
    (settings.data?.resolved.hiddenModels ?? []).map((m) => `${m.providerId} ${m.modelId}`)
  );

  const toggle = useMutation({
    mutationFn: (next: { providerId: string; modelId: string }[]) =>
      updateAdminSettings({ hiddenModels: next }),
    onSuccess: () => {
      clear();
      void client.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void client.invalidateQueries({ queryKey: keys.models() });
    },
    onError: fail,
  });

  const refresh = useMutation({
    mutationFn: () => refreshAdminModels(),
    onSuccess: () => {
      clear();
      void client.invalidateQueries({ queryKey: keys.models() });
    },
    onError: fail,
  });

  return (
    // `panel__models` is what gives this pane's row buttons a shared width:
    // Refresh sits above one Visible/Hidden per model, and a column of them
    // needs one right-hand edge. No other pane stacks buttons that way.
    <div className="panel__models">
      <Problem message={error} />

      <Row label="Discovery" description="Re-read the model list from every provider now.">
        <button type="button" onClick={() => refresh.mutate()}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </Row>

      {(models.data?.providers ?? []).flatMap((group) =>
        group.models.map((model) => {
          const isHidden = hidden.has(`${group.providerId} ${model.id}`);
          return (
            <Row
              key={`${group.providerId}/${model.id}`}
              label={model.id}
              description={group.providerName}
            >
              <button
                type="button"
                className="linkish"
                aria-label={`${isHidden ? 'Show' : 'Hide'} ${model.id}`}
                onClick={() => {
                  const current = settings.data?.resolved.hiddenModels ?? [];
                  const next = isHidden
                    ? current.filter(
                        (m) => !(m.providerId === group.providerId && m.modelId === model.id)
                      )
                    : [...current, { providerId: group.providerId, modelId: model.id }];
                  toggle.mutate(next);
                }}
              >
                {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
                {isHidden ? 'Hidden' : 'Visible'}
              </button>
            </Row>
          );
        })
      )}
    </div>
  );
}

/* --- sampler -------------------------------------------------------------- */

/**
 * Sampling, one model at a time.
 *
 * Its own section rather than a row that expands inside the model list: these
 * are six controls and a prompt box, which is more than a list row can hold
 * without the list stopping being a list.
 */
function SamplerSection(): React.JSX.Element {
  const client = useQueryClient();
  const [error, fail, clear] = useErrorMessage();
  const [chosen, setChosen] = useState('');

  const models = useModels(true);
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => fetchAdminSettings(signal),
  });

  const options = (models.data?.providers ?? []).flatMap((group) =>
    group.models.map((model) => ({
      value: `${group.providerId}\u0000${model.id}`,
      label: model.id,
    }))
  );

  // Land on the first model rather than an empty pane.
  const selected = chosen === '' ? (options[0]?.value ?? '') : chosen;
  const [providerId, modelId] = selected.split('\u0000');

  const model = (models.data?.providers ?? [])
    .find((group) => group.providerId === providerId)
    ?.models.find((m) => m.id === modelId);

  return (
    <>
      <Problem message={error} />

      <Row label="Model" description="Whose sampling you are editing.">
        <Select
          label="Model to configure"
          value={selected}
          options={options.length > 0 ? options : [{ value: '', label: 'No models' }]}
          onChange={setChosen}
        />
      </Row>

      {providerId !== undefined && modelId !== undefined && modelId !== '' && (
        <SamplerPanel
          providerId={providerId}
          modelId={modelId}
          stored={(settings.data?.resolved.samplers ?? []).find(
            (entry) => entry.providerId === providerId && entry.modelId === modelId
          )}
          defaults={model?.defaults}
          onSaved={() => {
            clear();
            void client.invalidateQueries({ queryKey: ['admin', 'settings'] });
          }}
          onError={fail}
        />
      )}
    </>
  );
}

/* --- settings ------------------------------------------------------------- */

function SettingsSection(): React.JSX.Element {
  const client = useQueryClient();
  const [error, fail, clear] = useErrorMessage();

  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => fetchAdminSettings(signal),
  });

  const models = useModels(true);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof updateAdminSettings>[0]) => updateAdminSettings(body),
    onSuccess: () => {
      clear();
      void client.invalidateQueries({ queryKey: ['admin', 'settings'] });
      void client.invalidateQueries({ queryKey: keys.session() });
      void client.invalidateQueries({ queryKey: keys.models() });
    },
    onError: fail,
  });

  const mode = settings.data?.resolved.registrationMode ?? 'closed';
  const current = settings.data?.resolved.defaultModel ?? null;

  return (
    <>
      <Problem message={error} />
      <Row
        label="Registration"
        description="Whether anyone can create their own account. Overrides the environment once set here."
      >
        <Select
          label="Registration mode"
          value={mode}
          options={[
            { value: 'closed', label: 'Closed' },
            { value: 'open', label: 'Open' },
          ]}
          onChange={(next) => save.mutate({ registrationMode: next as 'open' | 'closed' })}
        />
      </Row>

      <Row
        label="Default model"
        description="What a new conversation starts on, before anyone picks something else."
      >
        <ModelSelect
          label="Default model"
          groups={models.data?.providers ?? []}
          value={current}
          onChange={(choice) => save.mutate({ defaultModel: choice })}
        />
      </Row>
    </>
  );
}

/* --- maintenance ---------------------------------------------------------- */

const WINDOWS: { value: string; label: string }[] = [
  { value: '1', label: 'Last hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '12', label: 'Last 12 hours' },
  { value: '24', label: 'Last day' },
  { value: '', label: 'Everything' },
];

function MaintenanceSection({ currentUser }: { currentUser: UserDto }): React.JSX.Element {
  const client = useQueryClient();
  const [error, fail, clear] = useErrorMessage();
  const [result, setResult] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [window, setWindow] = useState('1');
  const [confirming, setConfirming] = useState(false);

  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => fetchAdminUsers(signal),
  });

  const clearHistory = useMutation({
    // Scoped to the signed-in account. Clearing somebody else's conversations
    // is a different act with different consequences, and does not belong
    // behind the same button as clearing your own.
    mutationFn: () =>
      clearAdminHistory({
        userId: currentUser.id,
        ...(window === '' ? {} : { withinHours: Number(window) as 1 | 6 | 12 | 24 }),
      }),
    onSuccess: (response) => {
      clear();
      setResult(
        `Deleted ${response.deleted} conversation${response.deleted === 1 ? '' : 's'}` +
          (response.cancelled > 0 ? `, stopping ${response.cancelled} in progress.` : '.')
      );
      // The reader may be looking at a conversation that has just gone.
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
    onError: fail,
  });

  const rebuild = useMutation({
    mutationFn: () => rebuildAdminIndex(target === '' ? undefined : target),
    onSuccess: (response) => {
      clear();
      setResult(`Rebuilt the index for ${response.users} user(s).`);
    },
    onError: fail,
  });

  return (
    <>
      <Problem message={error} />
      <Row
        label="Chat history"
        description="Deletes your own stored conversations within a chosen window. The files go from disk; there is no undo."
      >
        <Select label="How far back" value={window} options={WINDOWS} onChange={setWindow} />
        <button type="button" onClick={() => setConfirming(true)}>
          <Trash2 size={15} />
          Clear
        </button>
      </Row>

      {confirming && (
        <Dialog
          title="Clear chat history?"
          body={`${
            WINDOWS.find((w) => w.value === window)?.label ?? 'Everything'
          }, for ${currentUser.username}. The conversation files are removed from disk and cannot be recovered.`}
          confirmLabel="Clear"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            clearHistory.mutate();
          }}
        />
      )}

      <Row
        label="Conversation index"
        description="Rebuilds the derived index from the conversation files on disk."
      >
        <Select
          label="Rebuild for"
          value={target}
          options={[
            { value: '', label: 'All users' },
            ...(users.data ?? []).map((account) => ({
              value: account.id,
              label: account.username,
            })),
          ]}
          onChange={setTarget}
        />
        <button type="button" onClick={() => rebuild.mutate()}>
          <Database size={15} />
          Rebuild
        </button>
      </Row>
      {result !== null && <p className="muted small">{result}</p>}
    </>
  );
}
