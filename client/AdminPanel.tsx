import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Eye, EyeOff, Plug, RefreshCw, Settings2, Trash2, Users, X } from 'lucide-react';
import type { UserDto } from '@shared/auth.ts';
import {
  ApiError,
  createAdminProvider,
  createAdminUser,
  deleteAdminProvider,
  deleteAdminUser,
  fetchAdminProviders,
  fetchAdminSettings,
  fetchAdminUsers,
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

type Section = 'users' | 'providers' | 'models' | 'settings' | 'maintenance';

const SECTIONS: { id: Section; label: string; icon: typeof Users }[] = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'models', label: 'Models', icon: Eye },
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
      className="admin"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="admin__card" role="dialog" aria-modal="true" aria-label="Administration">
        <nav className="admin__rail" aria-label="Admin sections">
          <button
            type="button"
            className="icon-button admin__close"
            onClick={onClose}
            aria-label="Close administration"
          >
            <X size={18} />
          </button>

          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`admin__rail-item${section === id ? ' is-current' : ''}`}
              onClick={() => setSection(id)}
              aria-current={section === id}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>

        <div className="admin__pane">
          <h2 className="admin__title">{SECTIONS.find((s) => s.id === section)?.label}</h2>
          {section === 'users' && <UsersSection currentUser={user} />}
          {section === 'providers' && <ProvidersSection />}
          {section === 'models' && <ModelsSection />}
          {section === 'settings' && <SettingsSection />}
          {section === 'maintenance' && <MaintenanceSection />}
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
    <div className="admin__row">
      <div className="admin__row-text">
        <span className="admin__row-label">{label}</span>
        {description !== undefined && <p className="admin__row-desc">{description}</p>}
      </div>
      <div className="admin__row-control">{children}</div>
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
          <select
            aria-label={`Role for ${account.username}`}
            value={account.role}
            onChange={(event) =>
              update.mutate({
                id: account.id,
                changes: { role: event.target.value as 'user' | 'admin' },
              })
            }
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>

          <select
            aria-label={`Status for ${account.username}`}
            value={account.status}
            onChange={(event) =>
              update.mutate({
                id: account.id,
                changes: { status: event.target.value as 'active' | 'disabled' },
              })
            }
          >
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>

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
          className="admin__form"
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
          <div className="admin__form-actions">
            <button type="button" className="linkish" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" className="button-primary">
              Create user
            </button>
          </div>
        </form>
      ) : (
        <div className="admin__actions">
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
        <div className="admin__actions">
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
          className="admin__form"
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

          <div className="admin__form-actions">
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
    <>
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
  const currentKey = current === null ? '' : `${current.providerId}\u0000${current.modelId}`;

  return (
    <>
      <Problem message={error} />
      <Row
        label="Registration"
        description="Whether anyone can create their own account. Overrides the environment once set here."
      >
        <select
          aria-label="Registration mode"
          value={mode}
          onChange={(event) =>
            save.mutate({ registrationMode: event.target.value as 'open' | 'closed' })
          }
        >
          <option value="closed">Closed</option>
          <option value="open">Open</option>
        </select>
      </Row>

      <Row
        label="Default model"
        description="What a new conversation starts on, before anyone picks something else."
      >
        <select
          aria-label="Default model"
          value={currentKey}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') {
              save.mutate({ defaultModel: null });
              return;
            }
            const [providerId, modelId] = raw.split('\u0000');
            if (providerId !== undefined && modelId !== undefined) {
              save.mutate({ defaultModel: { providerId, modelId } });
            }
          }}
        >
          <option value="">No default</option>
          {(models.data?.providers ?? []).flatMap((group) =>
            group.models.map((model) => (
              <option
                key={`${group.providerId}/${model.id}`}
                value={`${group.providerId}\u0000${model.id}`}
              >
                {model.id}
              </option>
            ))
          )}
        </select>
      </Row>
    </>
  );
}

/* --- maintenance ---------------------------------------------------------- */

function MaintenanceSection(): React.JSX.Element {
  const [error, fail, clear] = useErrorMessage();
  const [result, setResult] = useState<string | null>(null);
  const [target, setTarget] = useState('');

  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => fetchAdminUsers(signal),
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
        label="Conversation index"
        description="Rebuilds the derived index from the conversation files on disk."
      >
        <select
          aria-label="Rebuild for"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">All users</option>
          {(users.data ?? []).map((account) => (
            <option key={account.id} value={account.id}>
              {account.username}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => rebuild.mutate()}>
          <Database size={15} />
          Rebuild
        </button>
      </Row>
      {result !== null && <p className="muted small">{result}</p>}
    </>
  );
}
