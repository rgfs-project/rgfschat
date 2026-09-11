import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Message } from '@shared/conversation.ts';
import type { SessionDto } from '@shared/auth.ts';
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  editMessage,
  fetchModels,
  fetchSession,
  getConversation,
  listConversations,
  regenerate,
  renameConversation,
  startGeneration,
  type ConversationDetail,
  type ConversationSummary,
  type ModelCatalogue,
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

/* --- writes -------------------------------------------------------------- */

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
    mutationFn: ({ conversationId, providerId, model, content }) =>
      startGeneration(conversationId, providerId, model, content),

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
