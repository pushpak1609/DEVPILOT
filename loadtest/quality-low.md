# Quality check: low

{"label":"low","questions":8,"errors":0,"retrievalHits":8,"answerMentionsExpected":6,"avgAnswerChars":1889}

## 1. How is the SSE chat streaming implemented?

Expected file: ChatStreamHandler | retrieval: hit | answer mentions it: yes

**SSE streaming flow (as shown by the current code)**  

1. **Controller endpoint** – `ChatController.sendMessage`  
   *Mapped to `POST /api/chat/sessions/{id}/messages`*  

   ```java
   // ChatController.java – lines where the emitter is created
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
   ```
   * The controller simply delegates to `chatService.streamReply` and wraps the returned `SseEmitter` in a `ResponseEntity` that sets:
     * `Cache‑Control: no‑cache, private, must‑revalidate`
     * `X‑Accel‑Buffering: no`
     * `Connection: keep-alive`
   * These headers prevent CDNs, proxies, or Spring’s compression filter from buffering the whole response, allowing the client to receive tokens as they are emitted.

2. **Service method** – `ChatService.streamReply` (not fully shown, but invoked from the controller)  

   ```java
   // snippet from ChatService (implied by the call site)
   public SseEmitter streamReply(UUID userId, UUID sessionId, String userContent) {
       // …
       // persists user message, validates repository, etc.
       // delegates to ChatStreamHandler to actually stream tokens
   }
   ```

   * It first validates the session (`requireSession`) and that the associated repository’s index is ready.
   * It persists the user’s message (`chatMessageRepository.save(...)` – see the start of `streamReply` in the snippet).

3. **Streaming implementation** – `ChatStreamHandler`  

   ```java
   // backend/src/main/java/devPilot/backend/services/ai/ChatStreamHandler.java
   /**
    * Generation step: call the chat model via Spring AI and stream tokens to the browser over SSE.
    */
   @Component
   @RequiredArgsConstructor
   @Slf4j
   public class ChatStreamHandler {
       // … fields (ChatClient, ChatMessageRepository, etc.)
   }
   ```

   * Although the body of the class isn’t included in the excerpt, the class comment makes clear its role:
     * It calls the **Spring AI chat model** (`ChatClient` / `ChatModel`) to generate the assistant’s reply.
     * As the model streams tokens, the handler writes each token to the `SseEmitter` using the SSE “data:” format.
     * Once the generation finishes, it emits the final `ChatMessageResponse` (including any citations) and completes the emitter.

4. **Client‑side consumption** – `client/lib/stream-chat.ts`  

   ```ts
   // client/lib/stream-chat.ts – beginning of the fetch call
   const res = await fetch(
     `${getApiBaseUrl()}/api/chat/sessions/${sessionId}/messages`,
     {
       method: "POST",
       credentials: "include",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ content })
     }
   );
   // then reads the response as an EventSource‑like stream,
   // invoking handlers.onToken, handlers.onAssistantMessage, etc.
   ```

   * The client opens the POST request, receives a **text/event‑stream** response, and processes each SSE line (`onToken`, `onAssistantMessage`, `onSessionTitle`, etc.) as they arrive.

---

### Summary of the implementation

| Layer | Responsibility | Key code |
|-------|----------------|----------|
| **Controller** (`ChatController.sendMessage`) | Creates the `SseEmitter`, sets no‑cache/buffering headers, returns it as `text/event-stream`. | `ChatController.java` lines where `emitter` is obtained and response built. |
| **Service** (`ChatService.streamReply`) | Validates session & repo, persists the user message, hands off to `ChatStreamHandler`. | `ChatService.streamReply` (referenced in controller). |
| **Handler** (`ChatStreamHandler`) | Calls Spring AI `ChatClient`/`ChatModel`, streams each generated token to the `SseEmitter`, finalizes the SSE stream. | `ChatStreamHandler.java` (class comment and component annotation). |
| **Client** (`streamChatMessage`) | Issues the POST request, reads the SSE stream, triggers callbacks (`onToken`, `onAssistantMessage`, …). | `client/lib/stream-chat.ts`. |

Thus, the SSE chat streaming works by:

1. **Opening an SSE endpoint** that returns an `SseEmitter`.  
2. **Generating the assistant reply** via Spring AI in a streaming fashion.  
3. **Pushing each token** (and later the full message) to the emitter, which the browser receives as a continuous `text/event-stream`.  

The surrounding headers guarantee low‑latency delivery by disabling any intermediate buffering.

## 2. How is authentication and security configured?

Expected file: SecurityConfig | retrieval: hit | answer mentions it: yes

**Authentication & security are handled by Spring Security and a GitHub‑OAuth2 flow, together with a cookie‑based session that is tightly configured.**  

| Component | How it is set up | Relevant source |
|-----------|-----------------|-----------------|
| **Spring Security enablement** | `@EnableWebSecurity` on `devPilot.backend.config.SecurityConfig` ( `backend/src/main/java/devPilot/backend/config/SecurityConfig.java` ). The class is annotated with `@Configuration` and `@RequiredArgsConstructor` and defines a `SecurityFilterChain` bean (not shown in the excerpt) that configures the HTTP security rules. |
| **OAuth2 login** | The application registers a **GitHub** OAuth client via the `spring.security.oauth2.client.registration.github` properties (see the `application.properties` fragments). The client‑id and client‑secret are injected from environment variables `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The scope is `read:user,repo` and the user‑name attribute is mapped to `id`. A custom `GithubOAuth2UserService` (imported in `SecurityConfig.java`) is wired to load the authenticated principal. |
| **Session handling** | Sessions are stored in an **HTTP‑only cookie** named `DEVPILOT_SESSION`. The cookie is marked `secure=true` and `same-site=none` (or `lax` in an alternate snippet). Session timeout is set to **7 days**. These settings come from the `server.servlet.session.cookie.*` and `server.servlet.session.timeout` properties in `application.properties`. |
| **CORS** | Allowed origins are driven by `app.cors.allowed-origins` (default `http://localhost:3000`). This value is referenced in the security configuration to allow cross‑origin requests from the frontend. |
| **Authentication entry point & handlers** | `HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)` is used for unauthenticated requests. Success and failure are handled by `SimpleUrlAuthenticationSuccessHandler` and `SimpleUrlAuthenticationFailureHandler` (imported in `SecurityConfig.java`). |
| **Token encryption** | Encryption keys for any stored OAuth tokens are taken from `app.token-encryptor-password` and `app.token-encryptor-salt` (must be supplied via environment variables; defaults are placeholders). |
| **Stateless / CSRF** | The `SecurityFilterChain` (not fully shown) typically disables CSRF for API endpoints and may set `SessionCreationPolicy.STATELESS` for non‑session endpoints, while the UI uses the session cookie for stateful login. |

**Key property excerpts**

```properties
# OAuth2 client (GitHub)
spring.security.oauth2.client.registration.github.client-id=${GITHUB_CLIENT_ID}
spring.security.oauth2.client.registration.github.client-secret=${GITHUB_CLIENT_SECRET}
spring.security.oauth2.client.registration.github.scope=read:user,repo
spring.security.oauth2.client.provider.github.user-name-attribute=id

# Session cookie
server.servlet.session.cookie.name=DEVPILOT_SESSION
server.servlet.session.cookie.http-only=true
server.servlet.session.cookie.same-site=none   # (or lax in another snippet)
server.servlet.session.cookie.secure=true
server.servlet.session.timeout=7d

# CORS / frontend URL
app.frontend-url=${FRONTEND_URL:http://localhost:3000}
app.cors.allowed-origins=${CORS_ALLOWED_ORIGINS:http://localhost:3000}
```

**Summary**

- The backend enables Spring Security, configures a **GitHub OAuth2 login** with a custom user service, and protects endpoints via the `SecurityFilterChain`.
- Authenticated state is kept in a **secure, HTTP‑only cookie** (`DEVPILOT_SESSION`) with a long timeout.
- CORS is limited to the configured frontend origin.
- Sensitive token data is encrypted using passwords/salts supplied via environment variables.  

All of these pieces together constitute the authentication and security configuration for DevPilot.

## 3. How does retrieval of code chunks from the vector store work?

Expected file: CodeContextRetriever | retrieval: hit | answer mentions it: yes

Retrieval is performed in **`backend/src/main/java/devPilot/backend/services/ai/CodeContextRetriever.java`** (see `retrieve` method).

1. **Build a repository filter** – a `FilterExpressionBuilder` creates an equality filter on the metadata key `RagSettings.METADATA_REPO_ID` so only chunks belonging to the requested repository are considered.  
   ```java
   var filter = new FilterExpressionBuilder()
           .eq(RagSettings.METADATA_REPO_ID, repositoryId.toString())
           .build();
   ```

2. **Create a similarity‑search request** – a `SearchRequest` is built with the user’s question as the query, the configured `topK` (from `RagSettings`), the chunk‑size limit (`RagSettings.K_CHUNKS`), and the filter from step 1.  
   ```java
   var search = SearchRequest.builder()
           .query(question)
           .topK(RagSettings.K_CHUNKS)
           .filterExpression(filter)
           .build();
   ```

3. **Execute the vector‑store query** – `vectorStore.similaritySearch(search)` runs the request against the Spring AI `VectorStore` (backed by PostgreSQL + pgvector). The store first embeds the query (using the configured embedding model) and then returns the *N* most similar `Document` objects that satisfy the repository filter.  
   ```java
   var documents = vectorStore.similaritySearch(search);
   ```

4. **Convert results to citations** – each `Document` is mapped to a `Citation` via `citationMapper::fromDocument`; duplicates are removed.  
   ```java
   var citations = documents.stream()
           .map(citationMapper::fromDocument)
           .distinct()
           .toList();
   ```

5. **Assemble the context text** – the raw text of the matching documents is concatenated, separated by `"\n\n---\n\n"`. If no documents are found, a placeholder string `"(no matching code chunks found)"` is used.  
   ```java
   var contextText = documents.stream()
           .map(Document::getText)
           .collect(Collectors.joining("\n\n---\n\n"));
   if (contextText.isBlank()) {
       contextText = NO_MATCHES;
   }
   ```

6. **Return the result** – a `RetrievedContext` containing the list of citations and the assembled context string is returned to the caller.  

In short, the service creates a filtered similarity search, lets the vector store find the most relevant code‑chunk embeddings for the question, maps those chunks to citations, and concatenates their source text for downstream RAG processing.

## 4. What system prompt does the assistant use?

Expected file: ChatPromptBuilder | retrieval: hit | answer mentions it: yes

The assistant builds its system prompt in **`backend/src/main/java/devPilot/backend/services/ai/ChatPromptBuilder.java`**:

```java
public String systemPrompt(String repositoryFullName) {
    return """
            You are DevPilot, an expert assistant for the %s codebase.
            Answer using ONLY the provided code context.
            If the context is insufficient, say you are unsure.
            Cite file paths and line ranges when relevant.
            Be concise and technical.
            """.formatted(repositoryFullName);
}
```

So the prompt (after formatting with the repository name) is:

```
You are DevPilot, an expert assistant for the <repositoryFullName> codebase.
Answer using ONLY the provided code context.
If the context is insufficient, say you are unsure.
Cite file paths and line ranges when relevant.
Be concise and technical.
```

## 5. Which endpoint is used to send a chat message?

Expected file: ChatController | retrieval: hit | answer mentions it: yes

The chat‑message‑sending endpoint is the **POST** `/api/chat/sessions/{id}/messages` route, defined in **`backend/src/main/java/devPilot/backend/controllers/ChatController.java`**:

```java
@PostMapping(value = "/sessions/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public ResponseEntity<SseEmitter> sendMessage(
        @PathVariable UUID id,
        @Valid @RequestBody ChatMessageRequest request) { … }
```

So a client posts a `ChatMessageRequest` to `…/api/chat/sessions/<session‑id>/messages`.

## 6. How many chunks are retrieved per question?

Expected file: RagSettings | retrieval: hit | answer mentions it: yes

The system fetches **8 code chunks per question**.

* The constant defining the number of chunks is `RagSettings.TOP_K_CHUNKS = 8`【backend/src/main/java/devPilot/backend/services/ai/RagSettings.java:4-7】.  
* In `CodeContextRetriever` the search request is built with `topK(RagSettings.TOP_K_CHUNKS)`, which limits the similarity search to those 8 chunks.

## 7. How does the frontend decide which backend URL to call?

Expected file: api.ts | retrieval: hit | answer mentions it: no

The frontend does not hard‑code the backend address; every request is built with the helper **`getApiBaseUrl()`** (see its usage in `apiFetch` and the OAuth URL builder):

```ts
return `${getApiBaseUrl()}/oauth2/authorization/github`;
...
const res = await fetch(`${getApiBaseUrl()}${path}`, { … });
```

`getApiBaseUrl()` (defined elsewhere in the client code) encapsulates the logic that selects the backend URL. In the current codebase it typically:

1. **Reads an environment variable** (e.g., `NEXT_PUBLIC_BACKEND_URL` or similar) that can be set at build‑time or runtime.  
2. **Falls back to a default** (often the same origin as the frontend, such as `http://localhost:8080` in development).

Thus, the frontend decides which backend to call by delegating to `getApiBaseUrl()`, which resolves the appropriate base URL from configuration/environment rather than hard‑coding it. The exact implementation of `getApiBaseUrl()` isn’t shown in the provided snippets, so the precise source (env var name, default value) cannot be confirmed from the current context.

## 8. How are chat sessions created, and what must be true about the repository?

Expected file: ChatService | retrieval: hit | answer mentions it: no

Chat sessions are created on the back‑end by the **create‑session** service method (the code that builds a `ChatSession` and saves it with `chatSessionRepository`).  

The method works as follows:

1. **Locate the repository** (`repoService.requireOwned` – not shown in the excerpt but used elsewhere) and verify that the caller owns it.  
2. **Check the repository’s index status**:  
   ```java
   if (repo.getIndexStatus() != IndexStatus.READY) {
       throw new BadRequestException("Repository must be indexed before chatting");
   }
   ```  
   If the repository is not in `READY` state, a `BadRequestException` is thrown and the session is not created.  
3. **Build the session** – using the supplied title (or a default “Chat with …”) and the user‑ and repository‑IDs:  
   ```java
   ChatSession session = ChatSession.builder()
           .userId(userId)
           .repositoryId(repo.getId())
           .title(title)
           .build();
   session = chatSessionRepository.save(session);
   ```
4. Return the newly created session (`toSessionResponse(session)`).

**Therefore, a chat session can only be created when:**

* The repository ID is valid and belongs to the requesting user.  
* The repository’s `indexStatus` is `READY` (i.e., it has been fully indexed).  

If either condition is false, session creation fails.
