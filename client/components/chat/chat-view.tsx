"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { IndexingState } from "@/components/chat/indexing-state";
import { AppShell } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import {
  useChatMessages,
  useChatSessions,
  useCreateChatSession,
  useStreamChat,
} from "@/hooks/use-chat";
import { useIndexStatus, useRepository } from "@/hooks/use-repos";

export function ChatView({ repoId }: { repoId: string }) {
  const repoQuery = useRepository(repoId);
  const isIndexing = repoQuery.data?.indexStatus === "INDEXING";
  const statusQuery = useIndexStatus(
    repoId,
    isIndexing || repoQuery.data?.indexStatus === "PENDING"
  );

  const indexStatus =
    statusQuery.data?.indexStatus ?? repoQuery.data?.indexStatus;
  const ready = indexStatus === "READY";

  const sessionsQuery = useChatSessions(repoId, ready);
  const createSession = useCreateChatSession(repoId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const autoCreateRef = useRef(false);

  // `selectedSessionId` is the single source of truth for which session is
  // being viewed. It's set explicitly (by user click, auto-create, or here)
  // rather than being re-derived from the sessions list on every render —
  // that derived-fallback approach used to mean deleting the *first* item
  // in the list could silently swap the active chat out from under you,
  // even if you'd never touched that session. This effect only fills in a
  // default once, and only when nothing is selected yet.
  useEffect(() => {
    if (!ready || sessionsQuery.isLoading || !sessionsQuery.isSuccess) return;

    const sessions = sessionsQuery.data ?? [];

    if (sessions.length === 0) {
      if (!autoCreateRef.current) {
        autoCreateRef.current = true;
        createSession.mutate(undefined, {
          onSuccess: (session) => setSelectedSessionId(session.id),
          onError: () => {
            autoCreateRef.current = false;
          },
        });
      }
      return;
    }

    if (selectedSessionId === null) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [
    ready,
    sessionsQuery.isLoading,
    sessionsQuery.isSuccess,
    sessionsQuery.data,
    selectedSessionId,
    createSession,
  ]);

  const sessionId = selectedSessionId;
  const messagesQuery = useChatMessages(sessionId);
  const { send, stop, streaming, streamText } = useStreamChat(sessionId);

  // Safety net: if the session we're viewing turns out not to exist
  // anymore (deleted from another tab/device, stale link, etc.), the
  // messages fetch will 404. Rather than sitting on an indefinite loading
  // skeleton, drop back to "no session selected" so the effect above picks
  // a fresh default (or creates a new chat if none remain).
  //
  // The handledErrorRef guard (and the eslint-disable below) exist because
  // this trips the newer "no setState in effects" advisory lint rule. That
  // rule is aimed at effects that redundantly mirror render-time state;
  // this one is legitimately syncing local state to an external system's
  // (react-query's) error state, which is what effects are for — but the
  // guard also has a real purpose beyond satisfying the linter: without
  // it, this effect fires again on every render while isError stays true,
  // which would call setSelectedSessionId repeatedly for no reason.
  const handledErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!messagesQuery.isError || !sessionId) return;
    if (handledErrorRef.current === sessionId) return;
    handledErrorRef.current = sessionId;

    toast.add({
      title: "Chat not found",
      description: "This chat may have been deleted. Switching to another one.",
      type: "error",
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedSessionId(null);
  }, [messagesQuery.isError, sessionId]);

  // Called when a session is deleted from the sidebar. If it was the one
  // currently open, clear the selection immediately so we don't keep
  // querying a session that no longer exists — the effect above will then
  // pick another session, or create a new one if the list is now empty.
  function handleSessionDeleted(deletedId: string) {
    setSelectedSessionId((prev) => (prev === deletedId ? null : prev));
  }

  if (repoQuery.isLoading) {
    return (
      <AppShell title="Loading chat…">
        <div className="grid flex-1 gap-4 p-4 md:grid-cols-[18rem_1fr]">
          <Skeleton className="min-h-80 rounded-2xl" />
          <Skeleton className="min-h-80 rounded-2xl" />
        </div>
      </AppShell>
    );
  }

  if (repoQuery.isError || !repoQuery.data) {
    return (
      <AppShell title="Repository unavailable">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <p className="text-sm text-muted-foreground">
            {(repoQuery.error as Error)?.message ?? "Repository not found"}
          </p>
          <Button render={<Link href="/dashboard" />}>Back to dashboard</Button>
        </div>
      </AppShell>
    );
  }

  const repo = repoQuery.data;

  return (
    <AppShell
      title={repo.fullName}
      description={
        ready
          ? "Ask questions grounded in this repository"
          : "Waiting for indexing to finish"
      }
      actions={
        <Button variant="outline" size="sm" render={<Link href="/dashboard" />}>
          <ArrowLeft data-icon="inline-start" />
          Repos
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ChatSidebar
          repo={{
            ...repo,
            indexStatus: indexStatus ?? repo.indexStatus,
            filesProcessed:
              statusQuery.data?.filesProcessed ?? repo.filesProcessed,
            filesTotal: statusQuery.data?.filesTotal ?? repo.filesTotal,
            chunkCount: statusQuery.data?.chunkCount ?? repo.chunkCount,
            errorMessage: statusQuery.data?.errorMessage ?? repo.errorMessage,
          }}
          sessionId={sessionId}
          onSelectSession={setSelectedSessionId}
          onSessionDeleted={handleSessionDeleted}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!ready ? (
            <IndexingState repo={repo} status={statusQuery.data} />
          ) : (
            <>
              <ChatMessages
                repo={repo}
                messages={messagesQuery.data ?? []}
                streaming={streaming}
                streamText={streamText}
                isLoading={messagesQuery.isLoading}
              />
              <ChatComposer
                disabled={!sessionId}
                streaming={streaming}
                onSend={send}
                onStop={stop}
              />
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}