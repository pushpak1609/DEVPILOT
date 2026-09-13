import { getApiBaseUrl, ApiError, type ChatMessage } from "@/lib/api";

export type StreamChatHandlers = {
  onUserMessage?: (message: ChatMessage) => void;
  onToken?: (token: string) => void;
  onAssistantMessage?: (message: ChatMessage) => void;
  onSessionTitle?: (title: string) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
};

export async function streamChatMessage(
  sessionId: string,
  content: string,
  handlers: StreamChatHandlers = {}
): Promise<void> {
  const res = await fetch(
    `${getApiBaseUrl()}/api/chat/sessions/${sessionId}/messages`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: handlers.signal,
    }
  );

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.message ?? data.error ?? message;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message);
  }

  if (!res.body) {
    throw new Error("No response body for SSE stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (!part.trim()) continue;

      const lines = part.split("\n");
      let event = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      const data = dataLines.join("\n");
      if (!data) continue;

      try {
        if (event === "token") {
          handlers.onToken?.(JSON.parse(data) as string);
        } else if (event === "user_message") {
          handlers.onUserMessage?.(JSON.parse(data) as ChatMessage);
        } else if (event === "assistant_message") {
          handlers.onAssistantMessage?.(JSON.parse(data) as ChatMessage);
        } else if (event === "session_title") {
          // Plain text event (see ChatStreamHandler#maybeGenerateTitle),
          // not JSON — no parsing needed.
          handlers.onSessionTitle?.(data);
        } else if (event === "done") {
          handlers.onDone?.();
        } else if (event === "error") {
          // Backend signals a failure mid-stream (e.g. Gemini API error, bad request).
          // Without this branch, these were silently ignored — the request would
          // just hang with no message, no error, no indication anything went wrong.
          let message = data;
          try {
            const parsed = JSON.parse(data);
            message = parsed?.message ?? parsed?.error ?? data;
          } catch {
            // data wasn't JSON, use it as-is
          }
          handlers.onError?.(new Error(message));
          return; // stop reading, the backend has ended the stream with an error
        }
      } catch (err) {
        handlers.onError?.(
          err instanceof Error ? err : new Error("Failed to parse SSE event")
        );
      }
    }
  }

  handlers.onDone?.();
}