"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Check, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";

import { IndexStatusBadge } from "@/components/dashboard/repo-status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useChatSessions,
  useCreateChatSession,
  useDeleteChatSession,
  useRenameChatSession,
} from "@/hooks/use-chat";
import { useStartIndexing } from "@/hooks/use-repos";
import type { ChatSession, Repository } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ChatSidebar({
  repo,
  sessionId,
  onSelectSession,
  onSessionDeleted,
}: {
  repo: Repository;
  sessionId: string | null;
  onSelectSession: (id: string) => void;
  onSessionDeleted?: (id: string) => void;
}) {
  const ready = repo.indexStatus === "READY";
  const sessionsQuery = useChatSessions(repo.id, ready);
  const createSession = useCreateChatSession(repo.id);
  const renameSession = useRenameChatSession(repo.id);
  const deleteSession = useDeleteChatSession(repo.id);
  const reindex = useStartIndexing();

  // Inline rename state: which session is being edited and its draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Session pending delete confirmation (null = dialog closed).
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);

  function startRename(session: ChatSession) {
    setEditingId(session.id);
    setEditValue(session.title);
  }

  function cancelRename() {
    setEditingId(null);
    setEditValue("");
  }

  function commitRename(session: ChatSession) {
    const title = editValue.trim();
    // No-op if unchanged or emptied out — don't send a pointless request,
    // and don't let a rename accidentally blank out a title.
    if (!title || title === session.title) {
      cancelRename();
      return;
    }
    renameSession.mutate(
      { sessionId: session.id, title },
      { onSettled: cancelRename }
    );
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const deletedId = deleteTarget.id;
    deleteSession.mutate(deletedId, {
      onSuccess: () => onSessionDeleted?.(deletedId),
    });
    setDeleteTarget(null);
  }

  return (
    <aside className="flex w-full flex-col border-b md:w-72 md:border-r md:border-b-0">
      <div className="space-y-3 p-4">
        <div className="space-y-1">
          <p className="truncate text-sm font-medium">{repo.fullName}</p>
          <div className="flex flex-wrap items-center gap-2">
            <IndexStatusBadge status={repo.indexStatus} />
            {repo.isPrivate && (
              <span className="text-xs text-muted-foreground">Private</span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!ready || createSession.isPending}
            onClick={() =>
              createSession.mutate("New chat", {
                onSuccess: (session) => onSelectSession(session.id),
              })
            }
          >
            <Plus data-icon="inline-start" />
            New chat
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={reindex.isPending || repo.indexStatus === "INDEXING"}
            onClick={() => reindex.mutate(repo.id)}
            aria-label="Re-index repository"
          >
            <RotateCcw />
          </Button>
        </div>
      </div>

      <Separator />

      <div className="px-4 py-2 text-xs font-medium text-muted-foreground">
        Sessions
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 px-2 pb-4">
          {!ready && (
            <p className="px-2 text-xs text-muted-foreground">
              Sessions unlock after indexing completes.
            </p>
          )}

          {sessionsQuery.isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-xl" />
            ))}

          {sessionsQuery.data?.map((session) => {
            const isEditing = editingId === session.id;

            return (
              <div
                key={session.id}
                className={cn(
                  "group relative w-full rounded-xl transition-colors hover:bg-muted",
                  sessionId === session.id && "bg-muted"
                )}
              >
                {isEditing ? (
                  <div className="flex items-center gap-1 px-2 py-2">
                    <Input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(session);
                        if (e.key === "Escape") cancelRename();
                      }}
                      className="h-8 text-sm"
                      maxLength={200}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      aria-label="Save title"
                      onClick={() => commitRename(session)}
                      disabled={renameSession.isPending}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      aria-label="Cancel rename"
                      onClick={cancelRename}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                      className="w-full rounded-xl px-3 py-2.5 pr-9 text-left"
                    >
                      <p className="truncate text-sm font-medium">{session.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(session.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </button>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label="Session options"
                        className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => startRename(session)}>
                          <Pencil className="size-4" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(session)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>
            );
          })}

          {ready && sessionsQuery.isSuccess && sessionsQuery.data.length === 0 && (
            <p className="px-2 text-xs text-muted-foreground">
              No chats yet. Start one to begin.
            </p>
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && (
                <>
                  &ldquo;{deleteTarget.title}&rdquo; and all its messages will be
                  permanently deleted. This can&apos;t be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}