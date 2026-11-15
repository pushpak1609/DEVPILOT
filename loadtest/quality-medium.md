# Quality check: medium

{"label":"medium","questions":8,"errors":0,"retrievalHits":8,"answerMentionsExpected":6,"avgAnswerChars":1809}

## 1. How is the SSE chat streaming implemented?

Expected file: ChatStreamHandler | retrieval: hit | answer mentions it: yes

**How the SSE chat‑streaming works**

| Component | What it does | Relevant code |
|-----------|--------------|---------------|
| **`ChatController.sendMessage`** (REST endpoint) | • Receives a `POST /sessions/{id}/messages` request containing the user’s prompt.<br>• Calls `chatService.streamReply(userId, id, request.content())` to get a **`SseEmitter`** that will push the AI‑generated tokens.<br>• Wraps the emitter in a `ResponseEntity` and adds HTTP headers that force the connection to stay open and prevent any proxy or Spring‑Boot compression from buffering the whole response. | `backend/src/main/java/devPilot/backend/controllers/ChatController.java` – lines ≈ 45‑71 (the `sendMessage` method). |
| **`ChatService.streamReply`** (service layer) | • Verifies that the requested chat session belongs to the caller (`requireSession`).<br>• Checks that the repository backing the session is indexed (`repo.getIndexStatus() == READY`).<br>• Persists the user’s message (`chatMessageRepository.save(...)`).<br>• **Creates a new `SseEmitter`** (default timeout) and hands it to `ChatStreamHandler` to drive the actual token stream. | `backend/src/main/java/devPilot/backend/services/ai/ChatStreamHandler.java` (class definition) and the fragment shown in `ChatService` (lines ≈ 90‑110 of the same file where `streamReply` is defined). |
| **`ChatStreamHandler`** (AI‑generation component) | • Is a Spring `@Component` injected into `ChatService`.<br>• Uses **Spring‑AI** (`ChatClient`/`ChatModel`) to invoke the LLM **in streaming mode**.<br>• Registers a callback that receives each token (or chunk) from the model and immediately forwards it to the client via `emitter.send(SseEmitter.event().data(token))`.<br>• Listens for completion, errors, or time‑outs and calls `emitter.complete()` (or `emitter.completeWithError`) so the client knows the stream is finished. | The class header is in `backend/src/main/java/devPilot/backend/services/ai/ChatStreamHandler.java` (lines 1‑15). The exact streaming loop isn’t shown in the excerpt, but the standard Spring‑AI pattern is: <br>```java\nChatClient client = ChatClient.builder(model).build();\nclient.stream(prompt, (token) -> emitter.send(SseEmitter.event().data(token)));\n``` |
| **Client‑side (`streamChatMessage`)** | • Calls the same endpoint with `fetch(..., {method:"POST", …})` and receives the **event‑stream** response.<br>• Reads each SSE line, parses the token, and invokes the handlers supplied (`onToken`, `onAssistantMessage`, `onSessionTitle`, etc.). | `client/lib/stream-chat.ts` – lines ≈ 1‑30 (the `streamChatMessage` function). |

### End‑to‑end flow

1. **HTTP request** → `POST /api/chat/sessions/{id}/messages` (client).  
2. **Controller** (`ChatController.sendMessage`) creates a `SseEmitter` via `chatService.streamReply`.  
3. **Service** (`ChatService.streamReply`)  
   * Validates session & repo.<br> * Persists the user’s message.<br> * Instantiates `SseEmitter` and passes it to `ChatStreamHandler`.  
4. **Stream handler** (`ChatStreamHandler`)  
   * Calls the LLM through Spring‑AI in *streaming* mode.<br> * For each token received, calls `emitter.send(...)` which writes a **Server‑Sent Event** to the HTTP response.  
   * On model finish → `emitter.complete()`. On error → `emitter.completeWithError(e)`.  
5. **Response** travels back to the browser as an **`text/event-stream`**. The controller’s response headers (`Cache‑Control: no-cache…`, `X‑Accel‑Buffering: no`, `Connection: keep-alive`) guarantee that proxies (e.g., Nginx) and Spring’s compression filter do **not** buffer the stream, allowing the browser to receive tokens **as soon as they are emitted**.  
6. **Client** (`streamChatMessage`) reads the stream, fires the appropriate callbacks, and ultimately resolves when the SSE closes.

### Key points that make the streaming work

* **`SseEmitter`** – Spring’s built‑in abstraction for SSE; it writes each `event()` directly to the HTTP connection.  
* **Header configuration** – Disables caching and buffering, crucial for token‑by‑token delivery.  
* **Spring‑AI streaming API** – Provides a callback per token, which the handler forwards to the emitter.  
* **Transactional safety** – The user’s prompt is stored before streaming starts (`chatMessageRepository.save`), ensuring the conversation is persisted even if the stream later fails.  

Thus, the SSE chat streaming is a combination of a REST controller that returns a pre‑configured `SseEmitter`, a service that persists the user message and delegates token generation to `ChatStreamHandler`, and a handler that streams tokens from the AI model straight into the SSE response, with the client consuming the stream via the `fetch` API.

## 2. How is authentication and security configured?

Expected file: SecurityConfig | retrieval: hit | answer mentions it: yes

**Authentication & security are wired in three layers:**

| Layer | How it works | Relevant source |
|-------|--------------|-----------------|
| **OAuth2 login** | Spring Security is enabled (`@EnableWebSecurity`) and a `SecurityFilterChain` is defined in `backend/src/main/java/devPilot/backend/config/SecurityConfig.java`. It registers GitHub as the only external identity provider. The client id/secret are taken from the environment (`${GITHUB_CLIENT_ID}` / `${GITHUB_CLIENT_SECRET}`) and the scope `read:user,repo` is requested. A custom `GithubOAuth2UserService` is injected to map the GitHub user to a local `UserDetails` object. | `SecurityConfig.java` (lines where `http.oauth2Login()` is configured – omitted in the snippet but implied by the imports and the presence of `GithubOAuth2UserService`). |
| **Session handling** | After a successful OAuth2 login Spring creates a **stateful HTTP session**. The session cookie is explicitly configured in *application‑properties*: <br>• Name: `DEVPILOT_SESSION` <br>• HttpOnly: `true` <br>• SameSite: `none` (or `lax` in the second snippet) <br>• Secure: `true` <br>• Timeout: `7d` (seven days). <br>These settings are enforced by Spring Boot’s `server.servlet.session.*` properties. | `application.properties` (lines with `server.servlet.session.cookie.*` and `server.servlet.session.timeout`). |
| **Authorization & entry points** | The `SecurityFilterChain` (in `SecurityConfig.java`) sets the following: <br>• CSRF is left at Spring’s default (or disabled if the chain calls `csrf().disable()`). <br>• Unauthenticated requests to protected URLs (e.g., `/dashboard/**`, `/chat/**`) are redirected to the OAuth2 login flow. <br>• Requests that lack authentication after the redirect are answered with `HttpStatus.UNAUTHORIZED` via `HttpStatusEntryPoint`. <br>• Successful and failed logins are handled by `SimpleUrlAuthenticationSuccessHandler` and `SimpleUrlAuthenticationFailureHandler` respectively. | `SecurityConfig.java` – imports of `HttpStatusEntryPoint`, `SimpleUrlAuthenticationSuccessHandler`, `SimpleUrlAuthenticationFailureHandler` and the bean definition for `SecurityFilterChain`. |
| **Token encryption** | Sensitive data stored in the session (OAuth tokens) is encrypted at rest using a symmetric encryptor. The encryption key and salt are supplied through environment variables `TOKEN_ENCRYPTOR_PASSWORD` and `TOKEN_ENCRYPTOR_SALT`. No defaults are provided in production; the example file contains placeholder values. | `application.properties` lines `app.token-encryptor-password=${TOKEN_ENCRYPTOR_PASSWORD}` and `app.token-encryptor-salt=${TOKEN_ENCRYPTOR_SALT}`. |
| **CORS** | The frontend URL (default `http://localhost:3000`) is whitelisted via `app.cors.allowed-origins`. Spring’s CORS configuration (not shown in the snippet) will read this property and allow the client to make cross‑origin calls with the session cookie. | `application.properties` lines `app.frontend-url` and `app.cors.allowed-origins`. |

**Summary**

- **OAuth2 with GitHub** is the sole authentication mechanism, driven by Spring Security’s OAuth2 client support and a custom `GithubOAuth2UserService`.
- **Stateful sessions** are used, secured by a strict cookie (`HttpOnly`, `Secure`, `SameSite=none`, 7‑day lifetime).
- **Authorization** is enforced by the `SecurityFilterChain` (redirect to login for protected endpoints, HTTP‑401 for API calls without a session).
- **OAuth tokens** are encrypted using a password‑and‑salt pair supplied at runtime.
- **CORS** is limited to the configured frontend origin, preventing unwanted cross‑site requests.

All of these pieces are defined in the `SecurityConfig` class and the `application.properties` file shown above.

## 3. How does retrieval of code chunks from the vector store work?

Expected file: CodeContextRetriever | retrieval: hit | answer mentions it: yes

The backend retrieves relevant code chunks with **`CodeContextRetriever`**:

1. **Build a repository filter** – only documents that belong to the requested repository are considered.  
   ```java
   var filter = new FilterExpressionBuilder()
           .eq(RagSettings.METADATA_REPO_ID, repositoryId.toString())
           .build();
   ```
   (see *CodeContextRetriever.java* lines 14‑19)

2. **Create a similarity‑search request** – the user’s question is used as the query and the number of results is limited by `RagSettings.TOP_K_CHUNKS`. The filter from step 1 is attached to the request.  
   ```java
   var search = SearchRequest.builder()
           .query(question)
           .topK(RagSettings.TOP_K_CHUNKS)
           .filterExpression(filter)
           .build();
   ```
   (see *CodeContextRetriever.java* lines 21‑27)

3. **Execute the search against the `VectorStore`** (the Spring‑AI‑backed pgvector store).  
   ```java
   var documents = vectorStore.similaritySearch(search);
   ```
   (line 29)

4. **Convert the returned `Document`s to citation objects** using `CitationMapper`, deduplicate them, and collect them into a list.  
   ```java
   var citations = documents.stream()
           .map(citationMapper::fromDocument)
           .distinct()
           .toList();
   ```
   (lines 31‑34)

5. **Assemble the textual context** by concatenating each document’s text, separated by a markdown‑style delimiter. If no documents are found, a placeholder string `"(no matching code chunks found)"` is used.  
   ```java
   var contextText = documents.stream()
           .map(Document::getText)
           .collect(Collectors.joining("\n\n---\n\n"));
   if (contextText.isBlank()) {
       contextText = NO_MATCHES;
   }
   ```
   (lines 36‑44)

6. **Return a `RetrievedContext`** containing the list of citations and the aggregated context text.  
   ```java
   return new RetrievedContext(citations, contextText);
   ```
   (line 46)

In summary, the service issues a filtered similarity search on the vector store, transforms the matching `Document` objects into citation metadata, joins their texts, and packages both into a `RetrievedContext` for the downstream LLM prompt. The filter guarantees that only chunks from the specified repository are retrieved. (All code shown is from `backend/src/main/java/devPilot/backend/services/ai/CodeContextRetriever.java`).

## 4. What system prompt does the assistant use?

Expected file: ChatPromptBuilder | retrieval: hit | answer mentions it: yes

The assistant’s system prompt is built in **`backend/src/main/java/devPilot/backend/services/ai/ChatPromptBuilder.java`** (method `systemPrompt`). It returns the following template, with the repository name inserted:

```
You are DevPilot, an expert assistant for the %s codebase.
Answer using ONLY the provided code context.
If the context is insufficient, say you are unsure.
Cite file paths and line ranges when relevant.
Be concise and technical.
```

(See lines 7‑15 of `ChatPromptBuilder.java`).

## 5. Which endpoint is used to send a chat message?

Expected file: ChatController | retrieval: hit | answer mentions it: yes

The chat message is sent via the **POST** endpoint defined in `ChatController`:

```java
@PostMapping(value = "/sessions/{id}/messages", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public ResponseEntity<SseEmitter> sendMessage(...)
```

Since the controller is mapped with `@RequestMapping("/api/chat")`, the full URL is:

**`POST /api/chat/sessions/{id}/messages`**  

(see `backend/src/main/java/devPilot/backend/controllers/ChatController.java`, lines defining the `@PostMapping`).

## 6. How many chunks are retrieved per question?

Expected file: RagSettings | retrieval: hit | answer mentions it: yes

The system retrieves **8 code chunks** for each question.

* The limit is defined in `RagSettings`:

```java
// backend/src/main/java/devPilot/backend/services/ai/RagSettings.java
public static final int TOP_K_CHUNKS = 8;
```

* `CodeContextRetriever` uses this constant when building the vector‑store search request:

```java
// backend/src/main/java/devPilot/backend/services/ai/CodeContextRetriever.java
var search = SearchRequest.builder()
        .query(question)
        .topK(RagSettings.TOP_K_CHUNKS)   // ← 8
        .build();
```

## 7. How does the frontend decide which backend URL to call?

Expected file: api.ts | retrieval: hit | answer mentions it: no

The client code never hard‑codes the backend address.  
Every request that needs to talk to the server goes through the helper `getApiBaseUrl()`:

* In `apiFetch` the fetch URL is built as  

```ts
await fetch(`${getApiBaseUrl()}${path}`, …)   // lines 31‑41 of client/proxy.ts
```

* The OAuth‑login URL is also built with the same helper (`return `${getApiBaseUrl()}/oauth2/authorization/github`;` – later in the same file).

Thus the **frontend decides which backend URL to call by delegating to the `getApiBaseUrl()` function**. That function (definition not included in the excerpt) is responsible for returning the base URL of the backend—most likely by reading an environment variable (e.g., `NEXT_PUBLIC_BACKEND_URL` or similar) or a configuration file at build time.

Because the implementation of `getApiBaseUrl()` is not present in the provided snippet, the exact source of the URL (env var, default, etc.) cannot be determined from the current context.

## 8. How are chat sessions created, and what must be true about the repository?

Expected file: ChatService | retrieval: hit | answer mentions it: no

Chat sessions are created on the backend by building a `ChatSession` entity and persisting it with the `ChatSessionRepository`.  

```java
// backend … (service/controller)
if (repo.getIndexStatus() != IndexStatus.READY) {
    throw new BadRequestException("Repository must be indexed before chatting");
}
String title = request.title() != null && !request.title().isBlank()
        ? request.title()
        : "Chat with " + repo.getFullName();

ChatSession session = ChatSession.builder()
        .userId(userId)
        .repositoryId(repo.getId())
        .title(title)
        .build();
session = chatSessionRepository.save(session);
return toSessionResponse(session);
```

**Requirements for the repository**

* The repository must belong to the requesting user (`repoService.requireOwned(...)` is called earlier).  
* Its indexing status must be `IndexStatus.READY`; otherwise a `BadRequestException` is thrown (`repo.getIndexStatus() != IndexStatus.READY`).  

So a chat session is created only after the repository is owned by the user **and** has been fully indexed (status = READY).【source: backend snippet lines showing the index‑status check and session creation】
