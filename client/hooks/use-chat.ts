"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { api, type ChatMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { streamChatMessage } from "@/lib/stream-chat";
import { toast } from "@/components/ui/toast";

/**
 * Appends `message` to `prev`, replacing any existing entry with the same id
 * (and always dropping `optimisticId` if present).
 *
 * This exists because of a real race: when a brand-new session's first
 * message is sent, the initial GET /messages fetch (useChatMessages) and the
 * SSE `user_message`/`assistant_message` events can both try to add the same
 * server-persisted message to the query cache. Without id-based dedup here,
 * whichever one runs second just appends a second copy with the identical
 * id, which shows up as a duplicate bubble and a React "duplicate key"
 * warning. Deduping by id makes this safe regardless of which one wins the
 * race.
 */
function upsertMessage(
  prev: ChatMessage[] | undefined,
  message: ChatMessage,
  optimisticId?: string
): ChatMessage[] {
  const withoutDuplicates = (prev ?? []).filter(
    (m) => m.id !== message.id && m.id !== optimisticId
  );
  return [...withoutDuplicates, message];
}

export function useChatSessions(repositoryId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chat.sessions(repositoryId),
    queryFn: () => api.listSessions(repositoryId),
    enabled: Boolean(repositoryId) && enabled,
  });
}

export function useChatMessages(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.chat.messages(sessionId ?? ""),
    queryFn: () => api.getMessages(sessionId!),
    enabled: Boolean(sessionId),
    // The message list for an open chat is only ever mutated by this client
    // (via SSE handlers below) after the initial load, so we don't want a
    // background refetch (e.g. on window focus) stomping on cache state
    // that the SSE handlers are actively updating mid-stream.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateChatSession(repositoryId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (title?: string) => api.createSession(repositoryId, title),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.sessions(repositoryId),
      });
      queryClient.setQueryData(queryKeys.chat.messages(session.id), []);
    },
    onError: (error: Error) => {
      toast.add({
        title: "Could not create chat",
        description: error.message,
        type: "error",
      });
    },
  });
}

export function useRenameChatSession(repositoryId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      api.renameSession(sessionId, title),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.sessions(repositoryId),
      });
    },
    onError: (error: Error) => {
      toast.add({
        title: "Could not rename chat",
        description: error.message,
        type: "error",
      });
    },
  });
}

export function useDeleteChatSession(repositoryId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => api.deleteSession(sessionId),
    onSuccess: (_data, sessionId) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.sessions(repositoryId),
      });
      // The messages cache for a deleted session is now meaningless —
      // drop it so a stale copy can't be read if the id is ever reused
      // in this client session (e.g. via back/forward navigation).
      queryClient.removeQueries({
        queryKey: queryKeys.chat.messages(sessionId),
      });
    },
    onError: (error: Error) => {
      toast.add({
        title: "Could not delete chat",
        description: error.message,
        type: "error",
      });
    },
  });
}

export function useStreamChat(sessionId: string | null) {
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous guard: React state (`streaming`) only updates on the next
  // render, so two send() calls fired in the same tick (e.g. a duplicate
  // keydown event from Enter) could both read `streaming === false` and both
  // go through. This ref is set synchronously and closes that gap.
  const sendingRef = useRef(false);
  // Buffer for tokens accumulated between animation frames (see onToken).
  const pendingTokensRef = useRef("");
  const rafRef = useRef<number | null>(null);

  const send = useCallback(
    async (content: string) => {
      if (!sessionId || !content.trim() || sendingRef.current) return;
      sendingRef.current = true;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const optimisticId = `temp-${Date.now()}`;
      const optimistic: ChatMessage = {
        id: optimisticId,
        role: "USER",
        content: content.trim(),
        citations: [],
        createdAt: new Date().toISOString(),
      };

      queryClient.setQueryData<ChatMessage[]>(
        queryKeys.chat.messages(sessionId),
        (prev) => [...(prev ?? []), optimistic]
      );

      setStreaming(true);
      setStreamText("");

      // Shared cleanup for both a mid-stream "error" event from the backend
      // and a network-level failure caught below — both should behave identically
      // from the user's point of view: show a toast, drop the optimistic bubble,
      // clear any partial streamed text.
      const handleFailure = (error: Error) => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        pendingTokensRef.current = "";
        toast.add({
          title: "Message failed",
          description: error.message,
          type: "error",
        });
        queryClient.setQueryData<ChatMessage[]>(
          queryKeys.chat.messages(sessionId),
          (prev) => (prev ?? []).filter((m) => m.id !== optimisticId)
        );
        setStreamText("");
      };

      try {
        await streamChatMessage(sessionId, content.trim(), {
          signal: controller.signal,
          onUserMessage: (message) => {
            queryClient.setQueryData<ChatMessage[]>(
              queryKeys.chat.messages(sessionId),
              (prev) => upsertMessage(prev, message, optimisticId)
            );
          },
          onToken: (token) => {
            // Buffer tokens and flush once per animation frame instead of
            // per token. Painting on every single token (via flushSync)
            // fixed the "whole response pops in at once" issue, but it also
            // meant the markdown renderer sometimes had to render a
            // mid-word / mid-list-marker state (e.g. "5. " with no content
            // yet), which Streamdown shows as a bare list number ("5")
            // until the rest of the line arrives. Batching by animation
            // frame still looks smooth to the eye (browsers repaint at
            // ~60fps max anyway) but gives the parser a few more
            // characters of context per render, so it very rarely lands on
            // a broken-looking intermediate state.
            pendingTokensRef.current += token;
            if (rafRef.current === null) {
              rafRef.current = requestAnimationFrame(() => {
                const chunk = pendingTokensRef.current;
                pendingTokensRef.current = "";
                rafRef.current = null;
                setStreamText((prev) => prev + chunk);
              });
            }
          },
          onAssistantMessage: (message) => {
            // Cancel any pending rAF flush and drop the buffer — the full,
            // authoritative message has arrived, so any not-yet-painted
            // trailing tokens are now redundant.
            if (rafRef.current !== null) {
              cancelAnimationFrame(rafRef.current);
              rafRef.current = null;
            }
            pendingTokensRef.current = "";
            queryClient.setQueryData<ChatMessage[]>(
              queryKeys.chat.messages(sessionId),
              (prev) => upsertMessage(prev, message)
            );
            setStreamText("");
          },
          onSessionTitle: () => {
            // The backend auto-generates a title after the first exchange
            // and has already persisted it — just invalidate so the
            // sidebar refetches and picks up the new title. We don't know
            // repositoryId here (useStreamChat is only scoped to a
            // sessionId), so invalidate any "chat sessions" query rather
            // than threading an extra param through this hook for one
            // cheap refetch.
            void queryClient.invalidateQueries({
              predicate: (query) =>
                query.queryKey[0] === "chat" && query.queryKey[1] === "sessions",
            });
          },
          onError: handleFailure,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        handleFailure(
          err instanceof Error ? err : new Error("Unknown error")
        );
      } finally {
        setStreaming(false);
        sendingRef.current = false;
      }
    },
    [sessionId, queryClient]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingTokensRef.current = "";
    setStreaming(false);
    sendingRef.current = false;
  }, []);

  return { send, stop, streaming, streamText };
}