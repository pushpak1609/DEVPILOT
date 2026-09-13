"use client";

import { Bot, UserRound } from "lucide-react";
import { useEffect, useRef } from "react";

import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { CitationChips } from "@/components/chat/citation-chips";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
} from "@/components/ui/message";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatMessage, Repository } from "@/lib/api";
import { cn } from "@/lib/utils";

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-1">
      <span className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-foreground/40" />
    </span>
  );
}

export function ChatMessages({
  repo,
  messages,
  streaming,
  streamText,
  isLoading,
}: {
  repo: Repository;
  messages: ChatMessage[];
  streaming?: boolean;
  streamText?: string;
  isLoading?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, streaming]);

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-6">
        <Skeleton className="h-16 w-2/3 rounded-3xl" />
        <Skeleton className="ml-auto h-12 w-1/2 rounded-3xl" />
        <Skeleton className="h-24 w-3/4 rounded-3xl" />
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {messages.length === 0 && !streaming && (
          <div className="rounded-2xl border border-dashed bg-muted/30 px-6 py-10 text-center">
            <p className="font-medium">Ask anything about this codebase</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try “Where is authentication handled?” or “Explain the repository
              indexing flow.”
            </p>
          </div>
        )}

        <MessageGroup>
          {messages.map((message) => {
            const isUser = message.role === "USER";
            return (
              <Message key={message.id} align={isUser ? "end" : "start"}>
                <MessageAvatar>
                  <Avatar className="size-8">
                    <AvatarFallback
                      className={cn(
                        isUser
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      )}
                    >
                      {isUser ? (
                        <UserRound className="size-4" />
                      ) : (
                        <Bot className="size-4" />
                      )}
                    </AvatarFallback>
                  </Avatar>
                </MessageAvatar>
                <MessageContent>
                  <Bubble
                    variant={isUser ? "default" : "muted"}
                    align={isUser ? "end" : "start"}
                    className={cn(!isUser && "max-w-full")}
                  >
                    <BubbleContent className={cn(!isUser && "w-full max-w-full px-4 py-3")}>
                      {isUser ? (
                        <span className="whitespace-pre-wrap">
                          {message.content}
                        </span>
                      ) : (
                        <ChatMarkdown content={message.content} />
                      )}
                    </BubbleContent>
                  </Bubble>
                  {!isUser && message.citations?.length > 0 && (
                    <MessageFooter>
                      <CitationChips repo={repo} citations={message.citations} />
                    </MessageFooter>
                  )}
                </MessageContent>
              </Message>
            );
          })}

          {/*
            IMPORTANT: this renders as soon as `streaming` is true, even before
            the first token arrives. Previously this was gated on `streamText`
            alone, which is an empty string during the retrieval + prompt-build
            + model-connect phase on the backend — so the assistant bubble was
            invisible for that whole window and the chat looked "stuck".
          */}
          {streaming && (
            <Message align="start">
              <MessageAvatar>
                <Avatar className="size-8">
                  <AvatarFallback className="bg-muted">
                    <Bot className="size-4" />
                  </AvatarFallback>
                </Avatar>
              </MessageAvatar>
              <MessageContent>
                <Bubble variant="muted" align="start" className="max-w-full">
                  <BubbleContent className="w-full max-w-full px-4 py-3">
                    {streamText ? (
                      <>
                        <ChatMarkdown content={streamText} isStreaming />
                        <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/50 align-middle" />
                      </>
                    ) : (
                      <TypingDots />
                    )}
                  </BubbleContent>
                </Bubble>
              </MessageContent>
            </Message>
          )}
        </MessageGroup>
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
