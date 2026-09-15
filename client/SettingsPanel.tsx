import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Brain,
  Database,
  KeyRound,
  Plus,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { UserDto } from '@shared/auth';
import {
  ApiError,
  clearMyHistory,
  deleteMyMemory,
  importExport,
  saveMyMemory,
  setMyDefaultModel,
  updateMyAccount,
  type ImportReport,
} from './api.ts';
import { Dialog } from './Dialog.tsx';
import { ModelSelect, type ModelChoice } from './ModelSelect.tsx';
import { Select } from './Select.tsx';
import { keys, useModels, useMyMemories, useMyPreferences } from './queries.ts';
import { Spinner } from './Spinner.tsx';

/**
 * A reader's own settings.
 *
 * The same shell as the admin panel, and deliberately so: these are the three
 * things an administrator could already do to an account — set its model,
 * clear its conversations, change its password — offered to the person the
 * account belongs to. Everything here acts on the caller alone; the routes
 * behind it take no user to act on.
 */

type Section = 'account' | 'model' | 'history' | 'memory' | 'import';

const SECTIONS: { id: Section; label: string; icon: typeof KeyRound }[] = [
  { id: 'account', label: 'Account', icon: KeyRound },
  { id: 'model', label: 'Model', icon: SlidersHorizontal },
  { id: 'history', label: 'Chat history', icon: Database },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'import', label: 'Import', icon: Upload },
];

export function SettingsPanel({
  user,
  onClose,
}: {
  user: UserDto;
  onClose: () => void;
}): React.JSX.Element {
  const [section, setSection] = useState<Section>('account');

  return createPortal(
    <div
      className="panel"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel__card" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="panel__rail" aria-label="Settings sections">
          <button
            type="button"
            className="icon-button panel__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={18} />
          </button>

          {/* Grouped so the narrow layout can scroll the sections sideways
              without the close button scrolling away with them. */}
          <div className="panel__rail-items">
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
          </div>
        </nav>

        <div className="panel__pane">
          <h2 className="panel__title">{SECTIONS.find((s) => s.id === section)?.label}</h2>

          {section === 'account' && <Account user={user} />}
          {section === 'model' && <DefaultModel />}
          {section === 'history' && <ChatHistory user={user} />}
          {section === 'memory' && <Memory />}
          {section === 'import' && <ImportChats />}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** One label/control row, the unit both panels are built from. */
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

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback;
}

/* --- account -------------------------------------------------------------- */

/**
 * Username and password, changed together.
 *
 * One form and one button, because both are the same request behind the same
 * proof: a session cookie says who you were when you signed in, which is not
 * the same as someone at the keyboard now being you. The new password is
 * optional so a rename does not force one.
 */
function Account({ user }: { user: UserDto }): React.JSX.Element {
  const client = useQueryClient();
  const [username, setUsername] = useState(user.username);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const renaming = username.trim() !== '' && username.trim() !== user.username;
  const changed = renaming || next !== '';

  const save = useMutation({
    mutationFn: () =>
      updateMyAccount({
        ...(renaming ? { username: username.trim() } : {}),
        currentPassword: current,
        ...(next === '' ? {} : { newPassword: next }),
      }),
    onSuccess: () => {
      setDone(true);
      setCurrent('');
      setNext('');
      // The session carries the username the header and the account row show.
      void client.invalidateQueries({ queryKey: keys.session() });
    },
    onError: (err) => setError(message(err, 'Could not save those changes.')),
  });

  return (
    <form
      className="panel__form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setDone(false);
        save.mutate();
      }}
    >
      <p className="panel__row-desc">
        Changing your username or password needs your current password.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && <p className="notice">Saved.</p>}

      <label className="field">
        <span>Username</span>
        <input
          value={username}
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </label>
      <label className="field">
        <span>
          New password <span className="muted">— leave blank to keep it</span>
        </span>
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </label>

      <div className="panel__form-actions">
        <button
          type="submit"
          className="button-primary"
          disabled={!changed || current === '' || save.isPending}
        >
          Save changes
        </button>
      </div>
    </form>
  );
}

/* --- default model -------------------------------------------------------- */

function DefaultModel(): React.JSX.Element {
  const client = useQueryClient();
  const models = useModels(true);
  const preferences = useMyPreferences();
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (choice: ModelChoice | null) => setMyDefaultModel(choice),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.preferences() }),
    onError: (err) => setError(message(err, 'Could not save your default model.')),
  });

  return (
    <>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <Row
        label="Default model"
        description="What a new conversation starts on. A conversation you are already in keeps the model it was using."
      >
        <ModelSelect
          label="Default model"
          groups={models.data?.providers ?? []}
          value={preferences.data?.defaultModel ?? null}
          onChange={(choice) => {
            setError(null);
            save.mutate(choice);
          }}
          disabled={preferences.isPending || models.isPending}
        />
      </Row>
    </>
  );
}

/* --- chat history --------------------------------------------------------- */

const WINDOWS = [
  { value: '1', label: 'Last hour' },
  { value: '6', label: 'Last 6 hours' },
  { value: '12', label: 'Last 12 hours' },
  { value: '24', label: 'Last day' },
  { value: '', label: 'Everything' },
];

function ChatHistory({ user }: { user: UserDto }): React.JSX.Element {
  const client = useQueryClient();
  const [window, setWindow] = useState('1');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);

  const clear = useMutation({
    mutationFn: () => clearMyHistory(window === '' ? undefined : Number(window)),
    onSuccess: (result) => {
      setCleared(result.deleted);
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
    onError: (err) => setError(message(err, 'Could not clear your history.')),
  });

  return (
    <>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {cleared !== null && (
        <p className="notice">
          {cleared} conversation{cleared === 1 ? '' : 's'} deleted.
        </p>
      )}

      <Row
        label="Clear chat history"
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
          body={`${WINDOWS.find((w) => w.value === window)?.label ?? 'Everything'}, for ${user.username}. The conversation files are removed from disk and cannot be recovered.`}
          confirmLabel="Clear"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setError(null);
            setCleared(null);
            clear.mutate();
          }}
        />
      )}
    </>
  );
}

/* --- memory --------------------------------------------------------------- */

/**
 * What the model is told about this reader before every conversation.
 *
 * A list of plain statements rather than named documents: a memory is usually
 * one sentence, and making somebody name a file before they can write one down
 * is a tax on the feature. The list is shown in full because a memory nobody
 * can read back is one nobody can correct — and nothing is added to it except
 * by the person reading it.
 */
function Memory(): React.JSX.Element {
  const client = useQueryClient();
  const memories = useMyMemories();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = (): void => void client.invalidateQueries({ queryKey: keys.memories() });

  const add = useMutation({
    mutationFn: (content: string) => saveMyMemory(content),
    onSuccess: () => {
      setDraft('');
      invalidate();
    },
    onError: (err) => setError(message(err, 'Could not save that memory.')),
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteMyMemory(name),
    onSuccess: invalidate,
    onError: (err) => setError(message(err, 'Could not delete that memory.')),
  });

  const list = memories.data ?? [];

  return (
    <>
      <p className="panel__row-desc">
        Told to the model at the start of every chat, in every conversation. Nothing is added here
        on its own — this list is exactly what it is told.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {memories.isPending && <Spinner small label="Loading memories…" />}

      <ul className="memories">
        {list.map((memory) => (
          <li key={memory.name} className="memories__item">
            <span className="memories__text">{memory.content.trim()}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Forget: ${memory.content.trim().slice(0, 40)}`}
              title="Forget this"
              onClick={() => {
                setError(null);
                remove.mutate(memory.name);
              }}
            >
              <X size={15} />
            </button>
          </li>
        ))}
      </ul>

      <form
        className="memories__add"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() === '') return;
          setError(null);
          add.mutate(draft.trim());
        }}
      >
        <input
          value={draft}
          placeholder="My dog's name is Beans"
          aria-label="Something to remember"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="icon-button"
          aria-label="Remember this"
          title="Remember this"
          disabled={draft.trim() === '' || add.isPending}
        >
          <Plus size={16} />
        </button>
      </form>
    </>
  );
}

/* --- import --------------------------------------------------------------- */

/**
 * Bringing conversations in from a Claude export.
 *
 * The whole zip is accepted, or any single file out of it, because that is
 * what people have to hand — and what was uploaded is decided by reading the
 * bytes rather than by trusting the name.
 */
function ImportChats(): React.JSX.Element {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => importExport(file),
    onSuccess: (result) => {
      setReport(result);
      void client.invalidateQueries({ queryKey: keys.conversations() });
      void client.invalidateQueries({ queryKey: keys.memories() });
    },
    onError: (err) => setError(message(err, 'Could not read that export.')),
  });

  return (
    <>
      <p className="panel__row-desc">
        Import a Claude data export — the zip from Settings → Privacy → Export data, or the
        conversations.json inside it. Conversations already here are left alone, so importing the
        same export twice imports it once.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {report !== null && (
        <p className="notice">
          {report.imported} conversation{report.imported === 1 ? '' : 's'} imported
          {report.memories > 0 ? `, ${report.memories} memory/memories` : ''}
          {report.skippedExisting > 0 ? `, ${report.skippedExisting} already here` : ''}
          {report.skippedEmpty > 0 ? `, ${report.skippedEmpty} empty` : ''}.
          {report.toolBlocks > 0 ? ` ${report.toolBlocks} tool block(s) left out.` : ''}
        </p>
      )}

      <input
        ref={input}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file === undefined) return;
          setError(null);
          setReport(null);
          upload.mutate(file);
        }}
      />

      <div className="panel__actions">
        <button type="button" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Upload size={15} />
          {upload.isPending ? 'Importing…' : 'Import chats'}
        </button>
      </div>
    </>
  );
}
