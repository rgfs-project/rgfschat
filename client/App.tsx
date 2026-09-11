import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, PanelLeft } from 'lucide-react';
import type { Message as MessageModel } from '@shared/conversation.ts';
import type { UserDto } from '@shared/auth.ts';
import {
  ApiError,
  cancelGeneration,
  createConversation,
  deleteConversation,
  deleteMessage,
  editMessage,
  fetchModels,
  getConversation,
  listConversations,
  regenerate,
  renameConversation,
  startGeneration,
  type ConversationSummary,
  type ProviderModelGroup,
} from './api.ts';
import { Composer } from './Composer.tsx';
import { Dialog } from './Dialog.tsx';
import { Message, StreamingMessage } from './Message.tsx';
import type { ModelSelection } from './ModelPicker.tsx';
import { Sidebar } from './Sidebar.tsx';
import { useGeneration } from './useGeneration.ts';
import { useScrollPin } from './useScrollPin.ts';

/** An in-flight generation survives a reload, so its id is parked in storage. */
const ACTIVE_KEY = 'workspace.activeGeneration';
const THEME_KEY = 'workspace.theme';
const SIDEBAR_KEY = 'workspace.sidebarCollapsed';
/** Last model used overall, the fallback for a conversation with no memory. */
const LAST_MODEL_KEY = 'workspace.lastModel';

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

/** Prefers a model the provider already has resident, else the first available. */
function defaultSelection(groups: ProviderModelGroup[]): ModelSelection | null {
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

export function App({
  user,
  onSignOut,
}: {
  user: UserDto;
  onSignOut: () => void;
}): React.JSX.Element {
  const [groups, setGroups] = useState<ProviderModelGroup[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageModel[]>([]);
  const [malformed, setMalformed] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [generationId, setGenerationId] = useState<string | null>(() => readStored(ACTIVE_KEY));
  const [awaitingMessageId, setAwaitingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);

  const [collapsed, setCollapsed] = useState(() => readStored(SIDEBAR_KEY) === 'true');
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

  const selection = useMemo(
    () =>
      (currentId !== null ? selectionByConversation[currentId] : undefined) ?? fallbackSelection,
    [currentId, selectionByConversation, fallbackSelection]
  );

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    writeStored(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    writeStored(SIDEBAR_KEY, collapsed ? 'true' : 'false');
  }, [collapsed]);

  const { onContentChange } = scroll;
  // Content changed: follow the bottom, or offer the jump.
  useEffect(() => {
    onContentChange();
  }, [messages, live.content, live.reasoning, onContentChange]);

  const refreshList = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load conversations.');
    }
  }, []);

  const openConversation = useCallback(async (id: string, awaitMessageId?: string) => {
    setError(null);
    setCurrentId(id);
    setMalformed(false);

    try {
      let detail = await getConversation(id);

      if (detail.activeGenerationId !== null) {
        writeStored(ACTIVE_KEY, detail.activeGenerationId);
        setGenerationId(detail.activeGenerationId);
      }

      // The assistant block is written just after the stream ends, so a reload
      // triggered by `done` can race the write.
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
      const isMalformed = err instanceof ApiError && err.code === 'CONVERSATION_MALFORMED';
      setMalformed(isMalformed);
      setError(isMalformed ? null : 'Could not open the conversation.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchModels()
      .then((list) => {
        if (controller.signal.aborted) return;
        setGroups(list);
        setFallbackSelection((current) => current ?? defaultSelection(list));
      })
      .catch(() => setError('Could not load models.'));

    void refreshList();
    return () => controller.abort();
  }, [refreshList]);

  // A reload with a remembered generation reopens its conversation.
  useEffect(() => {
    const remembered = readStored(ACTIVE_KEY);
    if (remembered === null) return;

    let cancelled = false;
    void listConversations()
      .then(async (list) => {
        for (const summary of list) {
          if (cancelled) return;
          const detail = await getConversation(summary.id).catch(() => null);
          if (detail?.activeGenerationId === remembered) {
            setCurrentId(detail.id);
            setMessages(detail.messages);
            return;
          }
        }
        writeStored(ACTIVE_KEY, null);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // Mount only.
  }, []);

  // Fold a settled generation back into the stored transcript.
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

    const pending = awaitingMessageId ?? undefined;
    writeStored(ACTIVE_KEY, null);
    setGenerationId(null);
    setAwaitingMessageId(null);

    if (currentId !== null) {
      void openConversation(currentId, pending).then(() => refreshList());
    }
  }, [live.state, generationId, currentId, awaitingMessageId, openConversation, refreshList]);

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

  const onCreate = useCallback(async () => {
    setError(null);
    try {
      const created = await createConversation();
      setMessages([]);
      setMalformed(false);
      setCurrentId(created.id);
      await refreshList();
    } catch {
      setError('Could not create a conversation.');
    }
  }, [refreshList]);

  const applyRename = useCallback(
    async (id: string, nextTitle: string) => {
      try {
        await renameConversation(id, nextTitle);
        await refreshList();
      } catch {
        setError('Could not rename the conversation.');
      }
    },
    [refreshList]
  );

  const onDeleteConversation = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
        if (currentId === id) {
          setCurrentId(null);
          setMessages([]);
          setMalformed(false);
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
    if (text === '' || selection === null || busy) return;

    setError(null);
    setPrompt('');

    /*
     * Typing is the act of starting a conversation, so one is created on the
     * first send rather than being a precondition for typing at all. Requiring
     * it up front meant the composer sat disabled behind a "select a
     * conversation first" placeholder — a dead field explaining its own
     * deadness, where the obvious thing to do was simply to begin.
     */
    let conversationId = currentId;
    if (conversationId === null) {
      try {
        const created = await createConversation();
        conversationId = created.id;
        setCurrentId(created.id);
        setMessages([]);
        setMalformed(false);
      } catch {
        setError('Could not create a conversation.');
        return;
      }
    }

    setMessages((previous) => [
      ...previous,
      { type: 'user', id: `pending-${Date.now()}`, body: text },
    ]);

    try {
      const accepted = await startGeneration(
        conversationId,
        selection.providerId,
        selection.modelId,
        text
      );
      writeStored(ACTIVE_KEY, accepted.generationId);
      setAwaitingMessageId(accepted.assistantMessageId);
      setGenerationId(accepted.generationId);
      await refreshList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the generation.');
      void openConversation(conversationId);
    }
  }, [prompt, selection, busy, currentId, openConversation, refreshList]);

  const onRegenerate = useCallback(async () => {
    if (currentId === null || selection === null || busy) return;

    setError(null);
    try {
      const accepted = await regenerate(currentId, selection.providerId, selection.modelId);
      writeStored(ACTIVE_KEY, accepted.generationId);
      setAwaitingMessageId(accepted.assistantMessageId);
      setGenerationId(accepted.generationId);
      setMessages((previous) =>
        previous.at(-1)?.type === 'assistant' ? previous.slice(0, -1) : previous
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not regenerate.');
    }
  }, [currentId, selection, busy]);

  const onEditMessage = useCallback(
    async (messageId: string, body: string) => {
      if (currentId === null) return;
      try {
        const detail = await editMessage(currentId, messageId, body);
        setMessages(detail.messages);
        await refreshList();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not edit the message.');
      }
    },
    [currentId, refreshList]
  );

  const onDeleteMessage = useCallback(
    async (messageId: string) => {
      if (currentId === null) return;

      try {
        const detail = await deleteMessage(currentId, messageId);
        if (detail === null) {
          setCurrentId(null);
          setMessages([]);
        } else {
          setMessages(detail.messages);
        }
        await refreshList();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not delete the message.');
      }
    },
    [currentId, refreshList]
  );

  const stop = useCallback(async () => {
    if (generationId === null) return;
    try {
      await cancelGeneration(generationId);
    } catch {
      // It may have finished between render and click.
    }
  }, [generationId]);

  const title = conversations.find((c) => c.id === currentId)?.title ?? 'New chat';
  const showEmptyState = !malformed && messages.length === 0 && !busy;

  return (
    <div className="shell" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      {!collapsed && (
        <Sidebar
          conversations={conversations}
          currentId={currentId}
          user={user}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onCollapse={() => setCollapsed(true)}
          onCreate={() => void onCreate()}
          onOpen={(id) => void openConversation(id)}
          onRename={(id, currentTitle) => setDialog({ kind: 'rename', id, title: currentTitle })}
          onDelete={(id) => setDialog({ kind: 'delete-conversation', id })}
          onSignOut={onSignOut}
        />
      )}

      <main className="main">
        <header className="main__header">
          {collapsed && (
            <button
              type="button"
              className="icon-button"
              onClick={() => setCollapsed(false)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeft size={18} />
            </button>
          )}
          <h2 className="main__title">{title}</h2>
        </header>

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
                  Its file on disk is not valid <code>formatVersion: 1</code> Markdown. Nothing has
                  been changed or repaired — the file is exactly as it was found, so you can inspect
                  or fix it by hand under <code>data/</code>. Deleting it here is the only action
                  available.
                </p>
                <button
                  type="button"
                  className="button-primary"
                  onClick={() =>
                    currentId !== null && setDialog({ kind: 'delete-conversation', id: currentId })
                  }
                >
                  Delete conversation
                </button>
              </div>
            )}

            {showEmptyState && (
              <div className="empty-state">
                <h2>What are we testing today?</h2>
                <p className="muted">{selection?.modelId ?? 'No model selected'}</p>
              </div>
            )}

            {!malformed &&
              messages.map((message, index) => (
                <Message
                  key={`${message.id}-${index}`}
                  message={message}
                  isLast={index === messages.length - 1}
                  busy={busy}
                  onEdit={(id, body) => void onEditMessage(id, body)}
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
              value={prompt}
              onChange={setPrompt}
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

      {dialog !== null && (
        <Dialog
          {...dialogProps(dialog)}
          onCancel={() => setDialog(null)}
          onConfirm={(value) => {
            setDialog(null);
            if (dialog.kind === 'rename') void applyRename(dialog.id, value);
            if (dialog.kind === 'delete-conversation') void onDeleteConversation(dialog.id);
            if (dialog.kind === 'delete-message') void onDeleteMessage(dialog.id);
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
