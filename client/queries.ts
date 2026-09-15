import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ArtifactDto } from '@shared/artifact';
import type { Message } from '@shared/conversation';
import type { SessionDto } from '@shared/auth';
import {
  createConversation,
  deleteArtifact,
  deleteConversation,
  deleteMessage,
  editMessage,
  fetchArtifacts,
  fetchArtifactSource,
  fetchModels,
  fetchMyMemories,
  fetchMyPreferences,
  fetchProposals,
  fetchSession,
  getConversation,
  listConversations,
  regenerate,
  pinConversation,
  renameConversation,
  resolveProposal,
  searchConversations,
  startGeneration,
  type ConversationDetail,
  type ConversationSummary,
  type MemoryDto,
  type MemoryProposalDto,
  type MePreferences,
  type ModelCatalogue,
  type SearchResult,
} from './api.ts';

/**
 * The client data layer.
 *
 * Every server read and write goes through here, so request ownership,
 * deduplication, cancellation on supersession, and stale-response rejection
 * are properties of *one* mechanism rather than of each call site. The
 * alternative — an `AbortController` and a loading flag per component — was
 * what this replaced, and it had no answer at all to a slow response for
 * conversation A landing after the user had already opened conversation B
 * (INV-23).
 */

/**
 * Query keys.
 *
 * Built from one place so a key can never be spelled two ways: a mutation
 * invalidating `['conversation', id]` while a hook reads `['conversations', id]`
 * fails silently and looks like a caching bug.
 */
export const keys = {
  session: () => ['session'] as const,
  models: () => ['models'] as const,
  conversations: () => ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  search: (query: string) => ['search', query] as const,
  preferences: () => ['me', 'preferences'] as const,
  memories: () => ['me', 'memories'] as const,
  proposals: (conversationId: string) => ['conversation', conversationId, 'proposals'] as const,
  artifacts: () => ['artifacts'] as const,
  artifactSource: (id: string) => ['artifact', id, 'source'] as const,
};

/**
 * Defaults chosen for a self-hosted single-user-ish app talking to a server on
 * the same machine.
 *
 * `refetchOnWindowFocus` is off because the data does not change behind the
 * user's back — they are the only writer — and a refetch storm on every focus
 * would be pure noise. Retries are off because the server is local: a failure
 * is a real failure worth showing, not a flaky network worth papering over,
 * and silent retries would make the error boundaries fire late.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 30_000,
      },
      mutations: { retry: false },
    },
  });
}

/* --- reads --------------------------------------------------------------- */

export function useSession(): UseQueryResult<SessionDto> {
  return useQuery({
    queryKey: keys.session(),
    queryFn: ({ signal }) => fetchSession(signal),
    // The session gates the whole app; never serve it stale.
    staleTime: 0,
  });
}

/**
 * `enabled` lets the caller start this before the session has resolved.
 *
 * The cold start fires session, conversations and models together rather than
 * waiting for auth, so first paint is not three round trips deep. If the
 * session comes back unauthenticated these are discarded.
 */
export function useConversations(enabled: boolean): UseQueryResult<ConversationSummary[]> {
  return useQuery({
    queryKey: keys.conversations(),
    queryFn: ({ signal }) => listConversations(signal),
    enabled,
  });
}

export function useModels(enabled: boolean): UseQueryResult<ModelCatalogue> {
  return useQuery({
    queryKey: keys.models(),
    queryFn: ({ signal }) => fetchModels(signal),
    enabled,
  });
}

/**
 * One conversation.
 *
 * The key carries the id, which is what makes rapid switching correct: opening
 * B while A is still in flight starts a separate entry, and A's response can
 * only ever land in A's. It cannot overwrite what is on screen (INV-23).
 */
export function useConversation(id: string | null): UseQueryResult<ConversationDetail> {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    queryFn: ({ signal }) => getConversation(id ?? '', signal),
    enabled: id !== null,
    // A conversation changes only through this client's own mutations, each of
    // which invalidates it explicitly.
    staleTime: Infinity,
  });
}

/**
 * Conversation search.
 *
 * Keyed by the query, so every keystroke's results are their own entry and a
 * slow answer for "pine" cannot overwrite the answer for "pineapple" that the
 * user is already reading (INV-23). Cached briefly: searching, refining and
 * backing up a character is one motion, and the previous query's results are
 * usually still on screen when it happens.
 */
export function useSearch(query: string): UseQueryResult<SearchResult[]> {
  return useQuery({
    queryKey: keys.search(query),
    queryFn: ({ signal }) => searchConversations(query, signal),
    enabled: query !== '',
    staleTime: 30_000,
  });
}

/** This reader's own settings: the model they start on, and what is remembered. */
export function useMyPreferences(enabled = true): UseQueryResult<MePreferences> {
  return useQuery({
    queryKey: keys.preferences(),
    queryFn: ({ signal }) => fetchMyPreferences(signal),
    enabled,
  });
}

export function useMyMemories(enabled = true): UseQueryResult<MemoryDto[]> {
  return useQuery({
    queryKey: keys.memories(),
    queryFn: ({ signal }) => fetchMyMemories(signal),
    enabled,
  });
}

/**
 * Memory changes the model has proposed in one conversation.
 *
 * Its own query rather than a field on the conversation: these live in their
 * own file server-side, and a conversation should still open when the
 * proposals beside it cannot be read.
 */
export function useProposals(conversationId: string | null): UseQueryResult<MemoryProposalDto[]> {
  return useQuery({
    queryKey: keys.proposals(conversationId ?? ''),
    queryFn: ({ signal }) => fetchProposals(conversationId as string, signal),
    enabled: conversationId !== null,
  });
}

/**
 * Accepts or rejects one.
 *
 * Both memories and proposals are invalidated on success: accepting writes a
 * memory, and either answer removes the card.
 */
export function useResolveProposal(): UseMutationResult<
  { applied: boolean },
  Error,
  { conversationId: string; proposalId: string; accept: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, proposalId, accept }) =>
      resolveProposal(conversationId, proposalId, accept),
    onSuccess: (_result, { conversationId }) => {
      void client.invalidateQueries({ queryKey: keys.proposals(conversationId) });
      void client.invalidateQueries({ queryKey: keys.memories() });
    },
  });
}

export function useArtifacts(enabled = true): UseQueryResult<ArtifactDto[]> {
  return useQuery({
    queryKey: keys.artifacts(),
    queryFn: ({ signal }) => fetchArtifacts(signal),
    enabled,
  });
}

/**
 * One artifact's source.
 *
 * Cached separately from the list, and for longer: the list changes when
 * something is imported or deleted, while an artifact's bytes never change at
 * all — nothing in this application rewrites one.
 */
export function useArtifactSource(id: string | null): UseQueryResult<string> {
  return useQuery({
    queryKey: keys.artifactSource(id ?? ''),
    queryFn: ({ signal }) => fetchArtifactSource(id as string, signal),
    enabled: id !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/* --- writes -------------------------------------------------------------- */

/**
 * Pinning, applied to the cached list before the server answers.
 *
 * A pin is a filing gesture: the row is expected to move the instant it is
 * clicked, and waiting a round trip to see whether it did makes the list feel
 * like it is arguing. The previous list is restored if the write fails.
 */
export function usePinConversation(): UseMutationResult<
  { pinned: boolean },
  Error,
  { id: string; pinned: boolean },
  { previous: ConversationSummary[] | undefined }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }) => pinConversation(id, pinned),
    onMutate: async ({ id, pinned }) => {
      await client.cancelQueries({ queryKey: keys.conversations() });
      const previous = client.getQueryData<ConversationSummary[]>(keys.conversations());

      client.setQueryData<ConversationSummary[]>(keys.conversations(), (current) =>
        current?.map((conversation) =>
          conversation.id === id ? { ...conversation, pinned } : conversation
        )
      );

      return { previous };
    },
    onError: (_error, _variables, context) => {
      client.setQueryData(keys.conversations(), context?.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
  });
}

export function useCreateConversation(): UseMutationResult<ConversationDetail, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => createConversation(),
    onSuccess: (created) => {
      client.setQueryData(keys.conversation(created.id), created);
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
  });
}

export function useRenameConversation(): UseMutationResult<
  ConversationDetail,
  Error,
  { id: string; title: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }) => renameConversation(id, title),
    onSuccess: (detail) => {
      client.setQueryData(keys.conversation(detail.id), detail);
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
  });
}

export function useDeleteArtifact(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteArtifact(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.artifacts() });
    },
  });
}

export function useDeleteConversation(): UseMutationResult<void, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: keys.conversation(id) });
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
  });
}

export function useEditMessage(): UseMutationResult<
  ConversationDetail,
  Error,
  { conversationId: string; messageId: string; body: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, messageId, body }) =>
      editMessage(conversationId, messageId, body),
    onSuccess: (detail) => {
      client.setQueryData(keys.conversation(detail.id), detail);
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
  });
}

export function useDeleteMessage(): UseMutationResult<
  ConversationDetail | null,
  Error,
  { conversationId: string; messageId: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, messageId }) => deleteMessage(conversationId, messageId),
    onSuccess: (detail, { conversationId }) => {
      // A null detail means the last message went and the conversation with it.
      if (detail === null) client.removeQueries({ queryKey: keys.conversation(conversationId) });
      else client.setQueryData(keys.conversation(conversationId), detail);
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },
  });
}

/** Everything the optimistic send needs to undo itself. */
export interface SendContext {
  conversationId: string;
  temporaryId: string;
  previous: ConversationDetail | undefined;
}

export interface SendVariables {
  conversationId: string;
  providerId: string;
  model: string;
  content: string;
  /** Uploaded and still pending; the server links them to the new message. */
  attachmentIds?: readonly string[];
}

/**
 * Sends a message, showing it before the server has acknowledged it.
 *
 * The optimistic entry carries a client-temporary id which is replaced by the
 * server's `userMessageId` from the 202 — the cache is the single source of
 * truth throughout, so there is never a second copy of the message to keep in
 * step. If the request fails the snapshot is put back and the message is gone
 * from the transcript, which is the truth: the server never received it.
 */
export function useSendMessage(): UseMutationResult<
  Awaited<ReturnType<typeof startGeneration>>,
  Error,
  SendVariables,
  SendContext
> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId, providerId, model, content, attachmentIds }) =>
      startGeneration(conversationId, providerId, model, content, attachmentIds ?? []),

    onMutate: async ({ conversationId, content }) => {
      const key = keys.conversation(conversationId);
      // Stop an in-flight read from landing on top of the optimistic entry.
      await client.cancelQueries({ queryKey: key });

      const previous = client.getQueryData<ConversationDetail>(key);
      const temporaryId = `pending-${crypto.randomUUID()}`;

      if (previous !== undefined) {
        const optimistic: Message = { type: 'user', id: temporaryId, body: content };
        client.setQueryData<ConversationDetail>(key, {
          ...previous,
          messages: [...previous.messages, optimistic],
        });
      }

      return { conversationId, temporaryId, previous };
    },

    onSuccess: (accepted, _variables, context) => {
      if (context === undefined) return;
      const key = keys.conversation(context.conversationId);

      // Reconcile: the temporary id becomes the server's.
      client.setQueryData<ConversationDetail>(key, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              messages: current.messages.map((message) =>
                message.id === context.temporaryId
                  ? { ...message, id: accepted.userMessageId }
                  : message
              ),
            }
      );
      void client.invalidateQueries({ queryKey: keys.conversations() });
    },

    onError: (_error, _variables, context) => {
      if (context?.previous === undefined) return;
      client.setQueryData(keys.conversation(context.conversationId), context.previous);
    },
  });
}

export function useRegenerate(): UseMutationResult<
  Awaited<ReturnType<typeof regenerate>>,
  Error,
  { conversationId: string; providerId: string; model: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, providerId, model }) =>
      regenerate(conversationId, providerId, model),
    onMutate: async ({ conversationId }) => {
      const key = keys.conversation(conversationId);
      await client.cancelQueries({ queryKey: key });
      // The reply being replaced goes now, so the transcript does not show the
      // old answer and the new one arriving underneath it.
      client.setQueryData<ConversationDetail>(key, (current) =>
        current === undefined || current.messages.at(-1)?.type !== 'assistant'
          ? current
          : { ...current, messages: current.messages.slice(0, -1) }
      );
    },
  });
}
