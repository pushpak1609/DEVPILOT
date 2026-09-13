package devPilot.backend.services.ai;

import java.util.List;
import java.util.UUID;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import devPilot.backend.dto.ChatMessageResponse;
import devPilot.backend.dto.CitationDto;
import devPilot.backend.entity.ChatMessage;
import devPilot.backend.entity.ChatSession;
import devPilot.backend.entity.MessageRole;
import devPilot.backend.repository.ChatMessageRepository;
import devPilot.backend.repository.ChatSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Generation step: call the chat model via Spring AI and stream tokens to the browser over SSE.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ChatStreamHandler {

    private final ChatModel chatModel;
    private final ChatMessageRepository chatMessageRepository;
    private final ChatSessionRepository chatSessionRepository;
    private final CitationMapper citationMapper;

    public SseEmitter stream(
            UUID sessionId,
            ChatMessageResponse savedUserMessage,
            List<CitationDto> citations,
            String systemPrompt,
            String userPrompt) {

        SseEmitter emitter = new SseEmitter(RagSettings.STREAM_TIMEOUT_MS);
        StringBuilder fullReply = new StringBuilder();

        try {
            emitter.send(SseEmitter.event()
                    .name("user_message")
                    .data(savedUserMessage));

            ChatClient.builder(chatModel)
                    .build()
                    .prompt()
                    .system(systemPrompt)
                    .user(userPrompt)
                    .stream()
                    .content()
                    .doOnNext(token -> appendToken(emitter, fullReply, token))
                    .doOnError(err -> {
                        log.error("Chat stream error", err);
                        sendErrorAndComplete(emitter, err);
                    })
                    .doOnComplete(() -> completeStream(
                            emitter, sessionId, fullReply, citations, savedUserMessage.content()))
                    .subscribe();
        } catch (Exception ex) {
            log.error("Failed to start chat stream", ex);
            sendErrorAndComplete(emitter, ex);
        }

        return emitter;
    }

    private void appendToken(SseEmitter emitter, StringBuilder fullReply, String token) {
        fullReply.append(token);
        try {
            emitter.send(SseEmitter.event()
                    .name("token")
                    .data(token, MediaType.APPLICATION_JSON));
        } catch (Exception ex) {
            // Thrown into the reactive chain -> triggers doOnError -> sendErrorAndComplete.
            // Do NOT call emitter.completeWithError here directly: this runs inside the
            // Reactor callback, and letting Reactor route it through doOnError keeps
            // error handling in exactly one place.
            throw new IllegalStateException(ex);
        }
    }

    /**
     * Sends a clean "error" SSE event the frontend can actually parse, then completes
     * the emitter normally.
     *
     * IMPORTANT: never use emitter.completeWithError() here. In Spring MVC that routes
     * the exception through the normal @ExceptionHandler machinery, which tries to write
     * a JSON error body — but the response Content-Type is already locked to
     * text/event-stream once streaming has started, so that write fails with
     * HttpMessageNotWritableException and the connection just dies with no signal
     * reaching the client. Sending our own "error" event and calling complete()
     * avoids that path entirely.
     */
    private void sendErrorAndComplete(SseEmitter emitter, Throwable err) {
        try {
            emitter.send(SseEmitter.event()
                    .name("error")
                    .data(friendlyMessage(err), MediaType.TEXT_PLAIN));
        } catch (Exception sendEx) {
            log.warn("Could not send error event to client", sendEx);
        } finally {
            emitter.complete();
        }
    }

    /**
     * Never forward raw exception messages to the client — they can contain API
     * keys, internal class names, or other details. Log the real error server-side
     * (already done by callers) and show the user something actionable instead.
     */
    private String friendlyMessage(Throwable err) {
        return "Something went wrong while generating a response. Please try again.";
    }

    private void completeStream(
            SseEmitter emitter,
            UUID sessionId,
            StringBuilder fullReply,
            List<CitationDto> citations,
            String firstUserMessage) {
        try {
            ChatMessage assistant = chatMessageRepository.save(ChatMessage.builder()
                    .sessionId(sessionId)
                    .role(MessageRole.ASSISTANT)
                    .content(fullReply.toString())
                    .citations(citationMapper.toJson(citations))
                    .build());

            emitter.send(SseEmitter.event()
                    .name("assistant_message")
                    .data(toMessageResponse(assistant)));

            // Auto-title: only on the very first exchange in a session
            // (1 user message + 1 assistant message = 2 total). Anything
            // after that keeps whatever title is already set.
            long messageCount = chatMessageRepository.countBySessionId(sessionId);
            if (messageCount == 2) {
                maybeGenerateTitle(emitter, sessionId, firstUserMessage, fullReply.toString());
            }

            emitter.send(SseEmitter.event().name("done").data("[DONE]"));
            emitter.complete();
        } catch (Exception ex) {
            log.error("Failed to finalize chat stream", ex);
            sendErrorAndComplete(emitter, ex);
        }
    }

    /**
     * Generates a short title from the first exchange and pushes it to the
     * client as its own SSE event so the sidebar can update live. This is a
     * best-effort step — if title generation fails for any reason, we log
     * it and move on rather than failing the whole chat response, since the
     * session already has a sensible fallback title ("Chat with <repo>")
     * from createSession.
     */
    private void maybeGenerateTitle(
            SseEmitter emitter, UUID sessionId, String userMessage, String assistantReply) {
        try {
            String prompt = """
                    Summarize the following exchange as a short chat title.
                    Rules: 3-6 words, no quotes, no trailing punctuation, plain text only.

                    User: %s
                    Assistant: %s
                    """.formatted(truncate(userMessage, 500), truncate(assistantReply, 500));

            String title = ChatClient.builder(chatModel)
                    .build()
                    .prompt(prompt)
                    .call()
                    .content();

            if (title == null || title.isBlank()) {
                return;
            }

            String cleanTitle = title.strip().replaceAll("^\"|\"$", "");
            if (cleanTitle.length() > 200) {
                cleanTitle = cleanTitle.substring(0, 200);
            }

            ChatSession session = chatSessionRepository.findById(sessionId).orElse(null);
            if (session == null) {
                return;
            }
            session.setTitle(cleanTitle);
            chatSessionRepository.save(session);

            emitter.send(SseEmitter.event()
                    .name("session_title")
                    .data(cleanTitle, MediaType.TEXT_PLAIN));
        } catch (Exception ex) {
            // Best-effort — a failed title generation should never break the chat.
            log.warn("Failed to generate session title for session {}", sessionId, ex);
        }
    }

    private String truncate(String text, int maxLen) {
        return text.length() <= maxLen ? text : text.substring(0, maxLen);
    }

    private ChatMessageResponse toMessageResponse(ChatMessage message) {
        return new ChatMessageResponse(
                message.getId(),
                message.getRole(),
                message.getContent(),
                citationMapper.fromJson(message.getCitations()),
                message.getCreatedAt());
    }
}