import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, PanelLeft } from 'lucide-react';
import type { ArtifactDto } from '@shared/artifact';
import type { UserDto } from '@shared/auth';
import { ApiError, cancelGeneration, downloadConversation, type MemoryProposalDto } from './api.ts';
import { ArtifactPanel } from './ArtifactPanel.tsx';
import { ArtifactsDialog } from './ArtifactsDialog.tsx';
import { Composer } from './Composer.tsx';
import { Dialog } from './Dialog.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { failureMessage } from './failureMessage.ts';
import { MemoryProposals } from './MemoryProposals.tsx';
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
  useMyPreferences,
  useProposals,
  useRegenerate,
  usePinConversation,
  useRenameConversation,
  useSendMessage,
} from './queries.ts';
import { IDLE_GENERATION, useGeneration } from './useGeneration.ts';
import { GenerationAnnouncer } from './GenerationAnnouncer.tsx';
import { useNarrowViewport } from './useNarrowViewport.ts';
import { useScrollPin } from './useScrollPin.ts';
import { useTailSpace } from './useTailSpace.ts';
import { useAttachments } from './useAttachments.ts';

/** An in-flight generation survives a reload, so it is parked in storage. */
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
 * The generation being watched, and the conversation it belongs to.
 *
 * The conversation id is the half that was missing, and everything downstream
 * needed it. A generation is server-owned and outlives the view: opening
 * another chat does not stop it (INV-06), so while it runs the reader can be
 * looking at a conversation it has nothing to do with. Without knowing whose it
 * is, the only question this component could answer was "is *a* generation
 * running", and it answered it in whichever transcript happened to be open —
 * so chat B showed chat A's dots, A's cursor, A's thinking, A's partial reply,
 * and reserved empty space under B's last message for an answer that was never
 * coming to B.
 */
interface ActiveGeneration {
  id: string;
  conversationId: string;
}

/**
 * Reads the parked generation back.
 *
 * A bare string is what this key held before it carried a conversation id, and
 * it is dropped rather than adopted: a generation whose conversation is unknown
 * is exactly the thing that used to leak. Nothing is lost by it — a run the
 * server still has is re-adopted from the conversation it belongs to as soon as
 * that conversation loads.
 */
function readActive(): ActiveGeneration | null {
  const raw = readStored(ACTIVE_KEY);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, conversationId } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || typeof conversationId !== 'string') return null;
    return { id, conversationId };
  } catch {
    return null;
  }
}

function writeActive(active: ActiveGeneration | null): void {
  writeStored(ACTIVE_KEY, active === null ? null : JSON.stringify(active));
}

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
  /**
   * The open conversation, or `null` for a draft that has no id yet.
   *
   * Read from the URL by `ChatRoute` rather than held as state here: the route
   * is what a reader can bookmark, reload, and press Back through, and two
   * copies of "which conversation" would eventually disagree about which one
   * is showing.
   */
  currentId: string | null;
  /** `null` opens the new-chat draft. Navigates; it does not set state. */
  onSelectConversation: (id: string | null) => void;
  /** Owned by the shell so it survives a session expiry and re-login. */
  draft: string;
  onDraftChange: (value: string) => void;
  /** A conversation has just been created by sending its first message. */
  onConversationCreated: (id: string) => void;
  onOpenSettings: () => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
}

export function App({
  user,
  currentId,
  onSelectConversation,
  draft,
  onDraftChange,
  onConversationCreated,
  onOpenSettings,
  onOpenAdmin,
  onSignOut,
}: AppProps): React.JSX.Element {
  const client = useQueryClient();

  const conversations = useConversations(true);
  const models = useModels(true);
  const conversation = useConversation(currentId);
  const preferences = useMyPreferences();
  const proposals = useProposals(currentId);

  const createConversation = useCreateConversation();
  const renameConversation = useRenameConversation();
  const deleteConversation = useDeleteConversation();
  const pinConversation = usePinConversation();
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage();
  const sendMessage = useSendMessage();
  const regenerate = useRegenerate();

  const attachments = useAttachments();
  const [generation, setGeneration] = useState<ActiveGeneration | null>(readActive);
  const generationId = generation?.id ?? null;
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  /*
   * The artifact open beside the transcript.
   *
   * Held here rather than in the dialog because it outlives it: choosing one
   * closes the list and leaves the panel open against the conversation, which
   * is the whole point of a panel rather than a second dialog.
   */
  const [artifact, setArtifact] = useState<ArtifactDto | null>(null);
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

  /**
   * Navigating closes the drawer, but only while it is one.
   *
   * A drawer covers what it navigates to: tapping a conversation on a phone
   * opened it *behind* the sidebar, so the reader arrived at a screen that
   * looked exactly like the one they had just left and had to dismiss the
   * drawer by hand to see the thing they had asked for. As a column on a wide
   * window it covers nothing, and closing it there would throw away a layout
   * the reader chose every time they changed conversation.
   */
  const dismissIfDrawer = useCallback(() => {
    if (narrow) setNarrowOpen(false);
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

  /*
   * The stream stays attached to whatever is running, wherever the reader is.
   *
   * Detaching on a conversation change would be the other way to stop the leak,
   * and a worse one: the run would go on without anyone watching, and coming
   * back to it would mean waiting for a fresh snapshot. This keeps the
   * observation channel open and *scopes what is rendered from it* instead.
   */
  const live = useGeneration(generationId);

  /**
   * The generation as this transcript sees it.
   *
   * `IDLE` for a conversation the running generation does not belong to, which
   * is the whole fix: every `busy` below, the streaming block, the announcer,
   * the tail reserve and the scroll follow read this rather than `live`, so a
   * run in another chat is invisible here — not merely hidden, but absent from
   * the state this view is computed from.
   */
  const isCurrent = generation !== null && generation.conversationId === currentId;
  const view = isCurrent ? live : IDLE_GENERATION;
  const busy = view.state === 'pending' || view.state === 'streaming';
  const scroll = useScrollPin();

  const groups = useMemo<ProviderGroups>(() => models.data?.providers ?? [], [models.data]);
  /**
   * The reader's own default wins over the instance's.
   *
   * Both are only a *starting* point: the last model used in a conversation
   * still wins inside that conversation, and the server checks the pair on
   * every generation regardless (INV-18).
   */
  const configuredDefault = preferences.data?.defaultModel ?? models.data?.defaultModel ?? null;

  useEffect(() => {
    if (groups.length === 0 || preferences.isPending) return;
    setFallbackSelection((current) => current ?? defaultSelection(groups, configuredDefault));
  }, [groups, configuredDefault, preferences.isPending]);

  const selection = useMemo(
    () =>
      (currentId !== null ? selectionByConversation[currentId] : undefined) ?? fallbackSelection,
    [currentId, selectionByConversation, fallbackSelection]
  );

  /**
   * Whether the chosen model can read an image.
   *
   * Read from discovery rather than configured: the provider reports each
   * model's input modalities, so this is what the server itself will check
   * against when the message is sent.
   */
  const modelHasVision = useMemo(() => {
    if (selection === null) return true;
    const group = groups.find((candidate) => candidate.providerId === selection.providerId);
    const model = group?.models.find((candidate) => candidate.id === selection.modelId);
    // Unknown means "do not warn": the server is the authority, and a warning
    // shown because the catalogue had not loaded would be noise.
    return model === undefined || model.inputModalities.includes('image');
  }, [groups, selection]);

  /** The conversation could not be parsed; only deletion is offered. */
  const malformed =
    conversation.error instanceof ApiError && conversation.error.code === 'CONVERSATION_MALFORMED';

  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);

  /**
   * Proposals grouped by the assistant turn that made them.
   *
   * Grouped once rather than filtered inside the render loop, which would walk
   * the whole list again for every message on every keystroke of a streaming
   * reply.
   */
  const proposalsByMessage = useMemo(() => {
    const grouped = new Map<string, MemoryProposalDto[]>();
    for (const proposal of proposals.data ?? []) {
      const existing = grouped.get(proposal.assistantMessageId);
      if (existing === undefined) grouped.set(proposal.assistantMessageId, [proposal]);
      else existing.push(proposal);
    }
    return grouped;
  }, [proposals.data]);

  const proposalsFor = useCallback(
    (messageId: string): MemoryProposalDto[] => proposalsByMessage.get(messageId) ?? [],
    [proposalsByMessage]
  );

  /**
   * The last question asked, which is the only one that can be asked again:
   * regeneration replaces the reply that follows it, and for an earlier turn
   * every exchange after it would have to be discarded too.
   */
  const lastUserIndex = useMemo(
    () => messages.findLastIndex((message) => message.type === 'user'),
    [messages]
  );

  /*
   * Empty room under the last turn, so asking a question puts it at the top of
   * the screen with its answer growing into the space below. Reserving it is
   * all it takes: the bottom of the transcript is then exactly that position,
   * and the scroll pin already aims at the bottom.
   */
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const tailSpace = useTailSpace({
    port: scroll.ref,
    content: transcriptRef,
    anchorId: lastUserIndex === -1 ? null : (messages[lastUserIndex]?.id ?? null),
    // So changing the reserve cannot slide the question down the screen and
    // bring the previous exchange back into view with it.
    adjustBy: scroll.adjustBy,
  });

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

  /*
   * A conversation change is not a scroll, and nothing about the last one
   * describes this one.
   *
   * Laid out before the paint that shows the new transcript, so it never
   * appears at the previous conversation's offset and then correct itself. The
   * reserve is rebuilt by its own layout effect against the new anchor, and the
   * streaming state is already scoped by conversation — this is the third of
   * the three things that used to cross over, and the visible one: the
   * jump-to-latest arrow, left pointing at a transcript that no longer existed,
   * hanging over an empty New chat.
   */
  const { reset: resetScroll } = scroll;
  useLayoutEffect(() => {
    resetScroll();
  }, [currentId, resetScroll]);

  const { onContentChange } = scroll;
  // Content changed: follow the bottom, or leave the reader where they are.
  // `tailSpace` among the triggers: applying the reserve moves the bottom, and
  // a view that was following the bottom has to follow it to the new one.
  useEffect(() => {
    onContentChange();
  }, [messages, view.content, view.reasoning, tailSpace, onContentChange]);

  /*
   * The answer has filled the room held for it, so the view stops moving.
   *
   * While the reserve lasts, following the bottom is exactly what holds the
   * question at the top of the screen. Once it is gone the two part company,
   * and following would scroll the reader down a line at a time while they are
   * still reading the top of the answer — so the rest of it arrives below the
   * fold, and reading on is a scroll they make themselves. The jump control
   * appears in the same moment as the way back down.
   */
  const { release } = scroll;
  useEffect(() => {
    if (busy && tailSpace === 0) release();
  }, [busy, tailSpace, release]);

  /*
   * A generation the server already has running is adopted from the
   * conversation itself, so a reload — or a different tab — resumes it without
   * relying on this client having remembered anything.
   */
  const activeGenerationId = conversation.data?.activeGenerationId ?? null;
  useEffect(() => {
    if (activeGenerationId === null || currentId === null) return;
    // Adopted *with* the conversation it was found on. Opening a chat with no
    // run of its own deliberately does not clear this: the one in the chat
    // behind it keeps going, and is simply not rendered here.
    const adopted = { id: activeGenerationId, conversationId: currentId };
    writeActive(adopted);
    setGeneration(adopted);
  }, [activeGenerationId, currentId]);

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
    if (generation === null) return;
    if (live.state === 'idle' || live.state === 'pending' || live.state === 'streaming') return;
    if (settledRef.current === generation.id) return;
    settledRef.current = generation.id;

    /*
     * A failure belongs to the conversation that asked, not to whichever one is
     * on screen when the answer lands. Raising the banner here regardless is
     * how a run in chat A used to put an error over chat B; the failed turn is
     * in A's transcript either way, which is where the reader will look.
     */
    if (generation.conversationId === currentId) {
      if (live.state === 'failed' || live.state === 'timed_out') {
        setError(
          live.state === 'timed_out'
            ? 'The model provider timed out.'
            : failureMessage(live.errorCode)
        );
      }
    }

    writeActive(null);
    setGeneration(null);

    void client.invalidateQueries({ queryKey: keys.conversations() });
    // The generation's own conversation, never the open one: refetching B
    // because A finished is both a wasted request and a way for A's terminal
    // event to change what B is showing.
    void client.invalidateQueries({ queryKey: keys.conversation(generation.conversationId) });
    // Proposals are filed as the reply is persisted, so they arrive on the
    // same event the message does — and without this the card only appeared
    // after something else happened to refetch.
    void client.invalidateQueries({ queryKey: keys.proposals(generation.conversationId) });
    /*
     * A completed reply may have presented files, which the server saves as it
     * persists the turn. The list is a separate query with its own cache, so
     * without this the artifact exists and the panel keeps showing the set it
     * last read — the reader is told to reload to see what they just made.
     */
    if (live.state === 'completed') {
      void client.invalidateQueries({ queryKey: keys.artifacts() });
    }
    // `errorCode` arrives in the same event as the terminal state; the ref
    // above is what keeps this to once per generation, not the dependencies.
  }, [live.state, live.errorCode, generation, currentId, client]);

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
    // Wherever the transcript had got to, the question being asked is the thing
    // to look at — and the reserve under it is what puts it at the top.
    scroll.pin();

    /*
     * Typing is the act of starting a conversation, so one is created on the
     * first send rather than being a precondition for typing at all.
     */
    let conversationId = currentId;
    if (conversationId === null) {
      try {
        const created = await createConversation.mutateAsync();
        conversationId = created.id;
        /*
         * The draft now has an id, so the URL takes it — replacing rather than
         * pushing. The reader did not navigate; they sent a message, and
         * pressing Back should return to wherever they were before the draft,
         * not to an empty composer whose message has already been sent.
         */
        onConversationCreated(created.id);
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
        attachmentIds: attachments.readyIds,
      });
      const started = { id: accepted.generationId, conversationId };
      writeActive(started);
      setGeneration(started);
      // Only once the server has them: cleared earlier, a failed send would
      // lose the files as well as the text.
      attachments.clear();
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
    onConversationCreated,
    scroll,
    attachments,
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
      const started = { id: accepted.generationId, conversationId: currentId };
      writeActive(started);
      setGeneration(started);
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
            onCreate={() => {
              onCreate();
              dismissIfDrawer();
            }}
            onOpen={(id) => {
              onSelectConversation(id);
              dismissIfDrawer();
            }}
            onSearch={() => setSearchOpen(true)}
            onOpenArtifacts={() => setArtifactsOpen(true)}
            onRename={(id, currentTitle) => setDialog({ kind: 'rename', id, title: currentTitle })}
            onDelete={(id) => setDialog({ kind: 'delete-conversation', id })}
            onPin={onPinConversation}
            onDownload={onDownloadConversation}
            onSettings={onOpenSettings}
            onOpenAdmin={onOpenAdmin}
            onSignOut={onSignOut}
            modal={narrow && sidebarOpen}
          />
        </div>
      </ErrorBoundary>

      {/*
        While the drawer is over the page, the page is not there to be used.

        `inert` rather than `aria-hidden`: the latter hides it from assistive
        technology but leaves every control tabbable and clickable, so a reader
        could still Tab into a transcript they cannot see behind a scrim. This
        is the half the focus trap cannot do — the trap keeps focus in, and this
        takes the page behind out of reach of everything else.
      */}
      <GenerationAnnouncer state={view.state} />

      <main
        className={`main${artifact !== null ? ' main--with-artifact' : ''}`}
        inert={narrow && sidebarOpen}
      >
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
            <div className="transcript__inner" ref={transcriptRef}>
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
                  <Fragment key={message.id}>
                    <Message
                      message={message}
                      isLast={index === messages.length - 1}
                      busy={busy}
                      canResend={index === lastUserIndex}
                      highlighted={message.id === focusMessageId}
                      onEdit={onEditMessage}
                      onDelete={(id) => setDialog({ kind: 'delete-message', id })}
                      onRegenerate={() => void onRegenerate()}
                    />
                    {/* Under the turn that asked, so the answer is given with
                        the conversation it came out of still in view. */}
                    {currentId !== null && proposalsFor(message.id).length > 0 && (
                      <MemoryProposals
                        conversationId={currentId}
                        proposals={proposalsFor(message.id)}
                      />
                    )}
                  </Fragment>
                ))}

              {busy && (
                <StreamingMessage
                  content={view.content}
                  reasoning={view.reasoning}
                  state={view.state}
                />
              )}

              {/* The reserve. Empty, and shrinking to nothing as the answer
                  fills the room it was holding. */}
              <div className="transcript__tail" style={{ height: tailSpace }} aria-hidden="true" />
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
              attachments={attachments}
              modelHasVision={modelHasVision}
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
          </div>
        </div>
      </main>

      {artifact !== null && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />}

      {searchOpen && (
        <SearchDialog recent={list} onOpen={onOpenResult} onClose={() => setSearchOpen(false)} />
      )}

      {artifactsOpen && (
        <ArtifactsDialog
          onOpen={(chosen) => {
            setArtifact(chosen);
            setArtifactsOpen(false);
          }}
          onClose={() => setArtifactsOpen(false)}
        />
      )}

      {/* Settings and Admin are routes now, rendered over this screen by
          `AppRoutes` so each has a URL that Back closes. */}

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
