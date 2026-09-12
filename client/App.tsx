import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, PanelLeft } from 'lucide-react';
import type { UserDto } from '@shared/auth.ts';
import { ApiError, cancelGeneration, downloadConversation } from './api.ts';
import { Composer } from './Composer.tsx';
import { AdminPanel } from './AdminPanel.tsx';
import { ChangePassword } from './ChangePassword.tsx';
import { Dialog } from './Dialog.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { Message, StreamingMessage } from './Message.tsx';
import type { ModelSelection } from './ModelPicker.tsx';
import { SearchDialog } from './SearchDialog.tsx';
import { Sidebar } from './Sidebar.tsx';
import {
  keys,
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  useDeleteMessage,
  useEditMessage,
  useModels,
  useRegenerate,
  usePinConversation,
  useRenameConversation,
  useSendMessage,
} from './queries.ts';
import { useGeneration } from './useGeneration.ts';
import { useNarrowViewport } from './useNarrowViewport.ts';
import { useScrollPin } from './useScrollPin.ts';

/** An in-flight generation survives a reload, so its id is parked in storage. */
const ACTIVE_KEY = 'workspace.activeGeneration';
const THEME_KEY = 'workspace.theme';
const SIDEBAR_KEY = 'workspace.sidebarCollapsed';
/** Last model used overall, the fallback for a conversation with no memory. */
const LAST_MODEL_KEY = 'workspace.lastModel';

/** Must outlast `--motion-theme` so the class is not pulled mid-fade. */
const THEME_FADE_MS = 320;

/** Long enough to find the marked message, short enough not to sit there. */
const MESSAGE_HIGHLIGHT_MS = 2000;

/**
 * A dialog waiting on the user.
 *
 * Held as state rather than resolved inline, because the portalled dialog is
 * asynchronous where `window.confirm` was blocking: the handler that opens it
 * has to return, and the work resumes when the user answers.
 */
type PendingDialog =
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'delete-conversation'; id: string }
  | { kind: 'delete-message'; id: string };

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

function parseSelection(raw: string | null): ModelSelection | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { providerId, modelId } = parsed as Partial<ModelSelection>;
    return typeof providerId === 'string' && typeof modelId === 'string'
      ? { providerId, modelId }
      : null;
  } catch {
    return null;
  }
}

/**
 * The model to start on.
 *
 * The administrator's configured default wins when there is one — the server
 * has already checked it is visible to this user. Otherwise prefer a model the
 * provider already has resident, so the first message does not pay for a load.
 */
function defaultSelection(
  groups: ProviderGroups,
  configured: ModelSelection | null
): ModelSelection | null {
  if (configured !== null) return configured;

  for (const group of groups) {
    if (group.status !== 'ready') continue;
    const loaded = group.models.find((model) => model.loaded);
    if (loaded !== undefined) return { providerId: group.providerId, modelId: loaded.id };
  }
  for (const group of groups) {
    const first = group.models[0];
    if (first !== undefined) return { providerId: group.providerId, modelId: first.id };
  }
  return null;
}

type ProviderGroups = NonNullable<ReturnType<typeof useModels>['data']>['providers'];

export interface AppProps {
  user: UserDto;
  /** Owned by the shell so it survives a session expiry and re-login. */
  currentId: string | null;
  onSelectConversation: (id: string | null) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSignOut: () => void;
}

export function App({
  user,
  currentId,
  onSelectConversation,
  draft,
  onDraftChange,
  onSignOut,
}: AppProps): React.JSX.Element {
  const client = useQueryClient();

  const conversations = useConversations(true);
  const models = useModels(true);
  const conversation = useConversation(currentId);

  const createConversation = useCreateConversation();
  const renameConversation = useRenameConversation();
  const deleteConversation = useDeleteConversation();
  const pinConversation = usePinConversation();
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage();
  const sendMessage = useSendMessage();
  const regenerate = useRegenerate();

  const [generationId, setGenerationId] = useState<string | null>(() => readStored(ACTIVE_KEY));
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** A message arrived at from search, to scroll to and mark once it renders. */
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState(() => readStored(SIDEBAR_KEY) === 'true');

  /*
   * A narrow window closes the sidebar, but does not *record* that choice: the
   * stored preference belongs to the reader, and widening the window again
   * should return the layout they picked rather than the one the viewport
   * imposed. So a narrow window gets its own open flag, which starts shut and
   * only the reader sets.
   */
  const narrow = useNarrowViewport();
  const [narrowOpen, setNarrowOpen] = useState(false);
  const sidebarOpen = narrow ? narrowOpen : !collapsed;

  const openSidebar = useCallback(() => {
    if (narrow) setNarrowOpen(true);
    else setCollapsed(false);
  }, [narrow]);

  const closeSidebar = useCallback(() => {
    if (narrow) setNarrowOpen(false);
    else setCollapsed(true);
  }, [narrow]);

  // Crossing the breakpoint starts over, so a sidebar opened on a narrow window
  // is not still open the next time the window becomes narrow.
  useEffect(() => {
    setNarrowOpen(false);
  }, [narrow]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    readStored(THEME_KEY) === 'dark' ? 'dark' : 'light'
  );

  /**
   * Model choice per conversation.
   *
   * Switching back to an older chat should return to the model it was using,
   * not whatever was picked most recently elsewhere.
   */
  const [selectionByConversation, setSelectionByConversation] = useState<
    Record<string, ModelSelection>
  >({});
  const [fallbackSelection, setFallbackSelection] = useState<ModelSelection | null>(() =>
    parseSelection(readStored(LAST_MODEL_KEY))
  );

  const live = useGeneration(generationId);
  const busy = live.state === 'pending' || live.state === 'streaming';
  const scroll = useScrollPin();

  const groups = useMemo<ProviderGroups>(() => models.data?.providers ?? [], [models.data]);
  const configuredDefault = models.data?.defaultModel ?? null;

  useEffect(() => {
    if (groups.length === 0) return;
    setFallbackSelection((current) => current ?? defaultSelection(groups, configuredDefault));
  }, [groups, configuredDefault]);

  const selection = useMemo(
    () =>
      (currentId !== null ? selectionByConversation[currentId] : undefined) ?? fallbackSelection,
    [currentId, selectionByConversation, fallbackSelection]
  );

  /** The conversation could not be parsed; only deletion is offered. */
  const malformed =
    conversation.error instanceof ApiError && conversation.error.code === 'CONVERSATION_MALFORMED';

  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);

  /**
   * The last question asked, which is the only one that can be asked again:
   * regeneration replaces the reply that follows it, and for an earlier turn
   * every exchange after it would have to be discarded too.
   */
  const lastUserIndex = useMemo(
    () => messages.findLastIndex((message) => message.type === 'user'),
    [messages]
  );

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    // Kept in step with the attribute so the browser repaints its own canvas,
    // scrollbars and form controls on a toggle, not just our styles. The same
    // pair is set by the inline script in index.html before the first paint.
    document.documentElement.style.colorScheme = theme;
    writeStored(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    writeStored(SIDEBAR_KEY, collapsed ? 'true' : 'false');
  }, [collapsed]);

  const { onContentChange } = scroll;
  // Content changed: follow the bottom, or leave the reader where they are.
  useEffect(() => {
    onContentChange();
  }, [messages, live.content, live.reasoning, onContentChange]);

  /*
   * A generation the server already has running is adopted from the
   * conversation itself, so a reload — or a different tab — resumes it without
   * relying on this client having remembered anything.
   */
  const activeGenerationId = conversation.data?.activeGenerationId ?? null;
  useEffect(() => {
    if (activeGenerationId === null) return;
    writeStored(ACTIVE_KEY, activeGenerationId);
    setGenerationId(activeGenerationId);
  }, [activeGenerationId]);

  /*
   * Fold a settled generation back into the stored transcript.
   *
   * Keyed by generation id rather than guarded by a "have I run" flag: the
   * question is whether *this* generation has been settled, which is a fact
   * about the data, not about how many times an effect happened to run.
   */
  /*
   * Marks the document while a theme change is in flight, so the colour
   * transition applies to that moment and not to every hover afterwards.
   */
  const themeFadeTimer = useRef<number | null>(null);
  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    root.classList.add('theme-transition');

    if (themeFadeTimer.current !== null) window.clearTimeout(themeFadeTimer.current);
    themeFadeTimer.current = window.setTimeout(() => {
      root.classList.remove('theme-transition');
      themeFadeTimer.current = null;
    }, THEME_FADE_MS);

    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(
    () => () => {
      if (themeFadeTimer.current !== null) window.clearTimeout(themeFadeTimer.current);
    },
    []
  );

  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (generationId === null) return;
    if (live.state === 'idle' || live.state === 'pending' || live.state === 'streaming') return;
    if (settledRef.current === generationId) return;
    settledRef.current = generationId;

    if (live.state === 'failed' || live.state === 'timed_out') {
      setError(
        live.state === 'timed_out'
          ? 'The model provider timed out.'
          : 'The generation failed. Check the server logs.'
      );
    }

    writeStored(ACTIVE_KEY, null);
    setGenerationId(null);

    void client.invalidateQueries({ queryKey: keys.conversations() });
    if (currentId !== null) {
      void client.invalidateQueries({ queryKey: keys.conversation(currentId) });
    }
  }, [live.state, generationId, currentId, client]);

  const onSelectModel = useCallback(
    (next: ModelSelection) => {
      setFallbackSelection(next);
      writeStored(LAST_MODEL_KEY, JSON.stringify(next));
      if (currentId !== null) {
        setSelectionByConversation((current) => ({ ...current, [currentId]: next }));
      }
    },
    [currentId]
  );

  /**
   * New chat clears the view; it does not create anything.
   *
   * Creating on the click left an untitled, empty conversation behind every
   * time someone opened one and changed their mind, and those accumulated in
   * the list as a row of identical "New conversation" entries with nothing in
   * them. A conversation now begins when there is something to put in it —
   * `send` creates one on the first message, which it already did for anyone
   * who started typing without opening a chat first.
   */
  const onCreate = useCallback(() => {
    setError(null);
    onSelectConversation(null);
  }, [onSelectConversation]);

  const applyRename = useCallback(
    (id: string, title: string) => {
      renameConversation.mutate(
        { id, title },
        { onError: () => setError('Could not rename the conversation.') }
      );
    },
    [renameConversation]
  );

  const onPinConversation = useCallback(
    (id: string, pinned: boolean) => {
      pinConversation.mutate(
        { id, pinned },
        { onError: () => setError('Could not change the pin.') }
      );
    },
    [pinConversation]
  );

  const onDownloadConversation = useCallback((id: string, title: string) => {
    downloadConversation(id, title).catch(() => setError('Could not download the conversation.'));
  }, []);

  const onDeleteConversation = useCallback(
    (id: string) => {
      deleteConversation.mutate(id, {
        onSuccess: () => {
          if (currentId === id) onSelectConversation(null);
        },
        onError: () => setError('Could not delete the conversation.'),
      });
    },
    [deleteConversation, currentId, onSelectConversation]
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === '' || selection === null || busy) return;

    setError(null);
    onDraftChange('');

    /*
     * Typing is the act of starting a conversation, so one is created on the
     * first send rather than being a precondition for typing at all.
     */
    let conversationId = currentId;
    if (conversationId === null) {
      try {
        const created = await createConversation.mutateAsync();
        conversationId = created.id;
        onSelectConversation(created.id);
      } catch {
        setError('Could not create a conversation.');
        onDraftChange(text);
        return;
      }
    }

    try {
      const accepted = await sendMessage.mutateAsync({
        conversationId,
        providerId: selection.providerId,
        model: selection.modelId,
        content: text,
      });
      writeStored(ACTIVE_KEY, accepted.generationId);
      setGenerationId(accepted.generationId);
    } catch (err) {
      // The optimistic message has already been rolled back by the mutation;
      // the text goes back in the composer so it is not simply lost.
      setError(err instanceof ApiError ? err.message : 'Could not start the generation.');
      onDraftChange(text);
    }
  }, [
    draft,
    selection,
    busy,
    currentId,
    createConversation,
    sendMessage,
    onDraftChange,
    onSelectConversation,
  ]);

  const onRegenerate = useCallback(async () => {
    if (currentId === null || selection === null || busy) return;

    setError(null);
    try {
      const accepted = await regenerate.mutateAsync({
        conversationId: currentId,
        providerId: selection.providerId,
        model: selection.modelId,
      });
      writeStored(ACTIVE_KEY, accepted.generationId);
      setGenerationId(accepted.generationId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not regenerate.');
    }
  }, [currentId, selection, busy, regenerate]);

  const onEditMessage = useCallback(
    (messageId: string, body: string, resend: boolean) => {
      if (currentId === null) return;
      editMessage.mutate(
        { conversationId: currentId, messageId, body },
        {
          // Only once the new wording is stored: regenerating first would
          // answer the question that was just replaced.
          onSuccess: () => {
            if (resend) void onRegenerate();
          },
          onError: () => setError('Could not edit the message.'),
        }
      );
    },
    [currentId, editMessage, onRegenerate]
  );

  /**
   * Opening a search result.
   *
   * The scroll cannot happen here: the conversation is very likely not loaded
   * yet, let alone rendered. The message is recorded instead, and the effect
   * below acts the first time it is actually on the page.
   */
  const onOpenResult = useCallback(
    (conversationId: string, messageId?: string) => {
      onSelectConversation(conversationId);
      setFocusMessageId(messageId ?? null);
    },
    [onSelectConversation]
  );

  useEffect(() => {
    if (focusMessageId === null) return;

    const target = document.querySelector(`[data-message-id="${focusMessageId}"]`);
    // Not rendered yet — this runs again when the conversation arrives.
    if (target === null) return;

    /*
     * Centred when the message fits, aligned to its top when it does not.
     *
     * Centring is what lets a short message be read with the turns around it.
     * But a long reply can be several screens tall, and centring *that* lands
     * halfway down a wall of text with no indication of what was found —
     * measured at 2500px past its own beginning on a real answer. Its first
     * line is the honest place to arrive.
     *
     * Scrolling here counts as intent, so the transcript unpins and a later
     * reply does not pull the view back down.
     */
    const tall = target.getBoundingClientRect().height > window.innerHeight;
    target.scrollIntoView({ block: tall ? 'start' : 'center' });

    const timer = window.setTimeout(() => setFocusMessageId(null), MESSAGE_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [focusMessageId, messages]);

  // The palette answers to the shortcut every other application uses for it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setSearchOpen(true);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onDeleteMessage = useCallback(
    (messageId: string) => {
      if (currentId === null) return;
      deleteMessage.mutate(
        { conversationId: currentId, messageId },
        {
          onSuccess: (detail) => {
            // Every message gone takes the conversation with it.
            if (detail === null) onSelectConversation(null);
          },
          onError: () => setError('Could not delete the message.'),
        }
      );
    },
    [currentId, deleteMessage, onSelectConversation]
  );

  const stop = useCallback(async () => {
    if (generationId === null) return;
    try {
      await cancelGeneration(generationId);
    } catch {
      // It may have finished between render and click.
    }
  }, [generationId]);

  const list = conversations.data ?? [];
  const title = list.find((c) => c.id === currentId)?.title ?? 'New chat';
  const showEmptyState = !malformed && messages.length === 0 && !busy;

  const noModels = models.isSuccess && groups.length === 0;
  const allProvidersUnavailable =
    models.isSuccess && groups.length > 0 && groups.every((g) => g.status === 'unavailable');

  return (
    <div
      className="shell"
      data-sidebar={sidebarOpen ? 'expanded' : 'collapsed'}
      data-narrow={narrow ? 'true' : 'false'}
    >
      {/* On a narrow window the sidebar covers the page, so it needs a way out
          that is not the control hidden underneath it. */}
      {sidebarOpen && narrow && (
        <div className="scrim" onPointerDown={closeSidebar} aria-hidden="true" />
      )}

      {/* Always mounted so it can slide; `inert` keeps it out of the tab order
          and away from assistive technology while it is off-screen. */}
      <ErrorBoundary region="sidebar">
        <div className="sidebar-host" inert={!sidebarOpen}>
          <Sidebar
            conversations={list}
            loading={conversations.isPending}
            currentId={currentId}
            user={user}
            theme={theme}
            onToggleTheme={toggleTheme}
            onCollapse={closeSidebar}
            onCreate={onCreate}
            onOpen={onSelectConversation}
            onSearch={() => setSearchOpen(true)}
            onRename={(id, currentTitle) => setDialog({ kind: 'rename', id, title: currentTitle })}
            onDelete={(id) => setDialog({ kind: 'delete-conversation', id })}
            onPin={onPinConversation}
            onDownload={onDownloadConversation}
            onChangePassword={() => setChangingPassword(true)}
            onOpenAdmin={() => setAdminOpen(true)}
            onSignOut={onSignOut}
          />
        </div>
      </ErrorBoundary>

      <main className="main">
        <header className="main__header">
          {/*
            On a narrow window this stays put whether the drawer is open or
            shut, so the title beside it never shifts. On a wide one the
            sidebar owns the control while it is open, and the header takes it
            back when it closes.
          */}
          {(!sidebarOpen || narrow) && (
            <button
              type="button"
              className="icon-button"
              onClick={sidebarOpen ? closeSidebar : openSidebar}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <PanelLeft size={18} />
            </button>
          )}
          <h2 className="main__title">{title}</h2>
        </header>

        {/* Keyed on the conversation so a failure in one does not persist into
            the next the reader opens. */}
        <ErrorBoundary region="transcript" resetKey={currentId}>
          <div className="transcript" ref={scroll.ref} data-testid="transcript">
            <div className="transcript__inner">
              {error !== null && (
                <p role="alert" className="error-banner">
                  {error}
                </p>
              )}

              {malformed && (
                <div className="malformed">
                  <h3>This conversation cannot be read</h3>
                  <p className="muted">
                    Its file on disk is not valid <code>formatVersion: 1</code> Markdown. Nothing
                    has been changed or repaired — the file is exactly as it was found, so you can
                    inspect or fix it by hand under <code>data/</code>. Deleting it here is the only
                    action available.
                  </p>
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() =>
                      currentId !== null &&
                      setDialog({ kind: 'delete-conversation', id: currentId })
                    }
                  >
                    Delete conversation
                  </button>
                </div>
              )}

              {showEmptyState && (
                <div className="empty-state">
                  <h2>What are we testing today?</h2>
                  {noModels ? (
                    <p className="muted">
                      No models are configured. Add a provider in{' '}
                      <code>data/_system/providers.json</code> and restart.
                    </p>
                  ) : allProvidersUnavailable ? (
                    <p className="muted">
                      Every provider is unreachable. Check that the model server is running.
                    </p>
                  ) : (
                    <p className="muted">{selection?.modelId ?? 'No model selected'}</p>
                  )}
                </div>
              )}

              {!malformed &&
                messages.map((message, index) => (
                  <Message
                    key={message.id}
                    message={message}
                    isLast={index === messages.length - 1}
                    busy={busy}
                    canResend={index === lastUserIndex}
                    highlighted={message.id === focusMessageId}
                    onEdit={onEditMessage}
                    onDelete={(id) => setDialog({ kind: 'delete-message', id })}
                    onRegenerate={() => void onRegenerate()}
                  />
                ))}

              {busy && (
                <StreamingMessage
                  content={live.content}
                  reasoning={live.reasoning}
                  state={live.state}
                />
              )}
            </div>
          </div>
        </ErrorBoundary>

        <div className="composer-region">
          <div className="composer-region__inner">
            {/* Floats above the composer without displacing it, so the layout
                does not shift as it comes and goes. */}
            {scroll.showJumpToLatest && (
              <button
                type="button"
                className="jump-to-latest"
                onClick={scroll.jumpToLatest}
                aria-label="Jump to latest"
                title="Jump to latest"
              >
                <ArrowDown size={20} />
              </button>
            )}

            <Composer
              value={draft}
              onChange={onDraftChange}
              onSend={() => void send()}
              onStop={() => void stop()}
              busy={busy}
              disabled={malformed}
              groups={groups}
              selection={selection}
              onSelectModel={onSelectModel}
            />
            <p className="composer-hint">Enter to send · Shift+Enter for a new line</p>
          </div>
        </div>
      </main>

      {searchOpen && (
        <SearchDialog recent={list} onOpen={onOpenResult} onClose={() => setSearchOpen(false)} />
      )}

      {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
      {adminOpen && <AdminPanel user={user} onClose={() => setAdminOpen(false)} />}

      {dialog !== null && (
        <Dialog
          {...dialogProps(dialog)}
          onCancel={() => setDialog(null)}
          onConfirm={(value) => {
            setDialog(null);
            if (dialog.kind === 'rename') applyRename(dialog.id, value);
            if (dialog.kind === 'delete-conversation') onDeleteConversation(dialog.id);
            if (dialog.kind === 'delete-message') onDeleteMessage(dialog.id);
          }}
        />
      )}
    </div>
  );
}

/** The wording for each dialog, kept out of the render for legibility. */
function dialogProps(
  dialog: PendingDialog
): Omit<React.ComponentProps<typeof Dialog>, 'onConfirm' | 'onCancel'> {
  switch (dialog.kind) {
    case 'rename':
      return {
        title: 'Rename conversation',
        defaultValue: dialog.title,
        fieldLabel: 'Title',
        confirmLabel: 'Rename',
      };
    case 'delete-conversation':
      return {
        title: 'Delete this conversation?',
        body: 'The conversation and every message in it are removed. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      };
    case 'delete-message':
      return {
        title: 'Delete this message?',
        body: 'The reply that followed it is removed too. Deleting the last remaining messages removes the conversation.',
        confirmLabel: 'Delete',
        destructive: true,
      };
  }
}
