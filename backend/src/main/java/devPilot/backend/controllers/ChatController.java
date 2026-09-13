package devPilot.backend.controllers;

import java.util.List;
import java.util.UUID;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import devPilot.backend.dto.ChatMessageRequest;
import devPilot.backend.dto.ChatMessageResponse;
import devPilot.backend.dto.ChatSessionResponse;
import devPilot.backend.dto.CreateChatSessionRequest;
import devPilot.backend.dto.RenameSessionRequest;
import devPilot.backend.security.CurrentUser;
import devPilot.backend.services.ChatService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/chat")
@RequiredArgsConstructor
public class ChatController {

    private final CurrentUser currentUser;
    private final ChatService chatService;

    @PostMapping("/sessions")
    public ResponseEntity<ChatSessionResponse> createSession(
            @Valid @RequestBody CreateChatSessionRequest request) {
        UUID userId = currentUser.require().getId();
        return ResponseEntity.ok(chatService.createSession(userId, request));
    }

    @GetMapping("/sessions")
    public List<ChatSessionResponse> listSessions(@RequestParam UUID repositoryId) {
        UUID userId = currentUser.require().getId();
        return chatService.listSessions(userId, repositoryId);
    }

    @GetMapping("/sessions/{id}")
    public List<ChatMessageResponse> getMessages(@PathVariable UUID id) {
        UUID userId = currentUser.require().getId();
        return chatService.getMessages(userId, id);
    }

    /**
     * Renames a session's title. Used both for manual rename and for the
     * auto-generated title patched in after the first exchange completes.
     */
    @PatchMapping("/sessions/{id}")
    public ChatSessionResponse renameSession(
            @PathVariable UUID id,
            @Valid @RequestBody RenameSessionRequest request) {
        UUID userId = currentUser.require().getId();
        return chatService.renameSession(userId, id, request.title());
    }

    /**
     * Hard-deletes a session and all its messages. This is permanent —
     * there is no soft-delete/undo.
     */
    @DeleteMapping("/sessions/{id}")
    public ResponseEntity<Void> deleteSession(@PathVariable UUID id) {
        UUID userId = currentUser.require().getId();
        chatService.deleteSession(userId, id);
        return ResponseEntity.noContent().build();
    }

    /**
     * SSE streaming endpoint.
     *
     * IMPORTANT: we wrap the SseEmitter in a ResponseEntity so we can attach
     * headers that stop intermediaries from buffering the whole response
     * before delivering it:
     *  - Cache-Control: no-cache, no-transform  -> tells caches/CDNs/proxies
     *    not to buffer or transform the stream.
     *  - X-Accel-Buffering: no                  -> disables response
     *    buffering specifically in Nginx, which otherwise waits for the
     *    stream to finish (or its buffer to fill) before sending anything
     *    to the browser. This is the single most common reason an SSE
     *    stream looks like it "arrives all at once" instead of token by
     *    token.
     *  - Also disables Spring Boot's response-compression filter for this
     *    endpoint's content type, if compression is enabled globally
     *    (see application.properties) — compression buffers the entire
     *    body before it can compress it, which has the same effect.
     */
    @PostMapping(value = "/sessions/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<SseEmitter> sendMessage(
            @PathVariable UUID id,
            @Valid @RequestBody ChatMessageRequest request) {
        UUID userId = currentUser.require().getId();
        SseEmitter emitter = chatService.streamReply(userId, id, request.content());

        HttpHeaders headers = new HttpHeaders();
        headers.setCacheControl(CacheControl.noCache().cachePrivate().mustRevalidate());
        headers.add("X-Accel-Buffering", "no");
        headers.add("Connection", "keep-alive");

        return ResponseEntity.ok()
                .headers(headers)
                .contentType(MediaType.TEXT_EVENT_STREAM)
                .body(emitter);
    }
}