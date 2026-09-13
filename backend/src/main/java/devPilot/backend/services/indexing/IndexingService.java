package devPilot.backend.services.indexing;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;
import org.springframework.ai.document.Document;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.ai.vectorstore.filter.FilterExpressionBuilder;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;

import devPilot.backend.entity.IndexStatus;
import devPilot.backend.entity.Repository;
import devPilot.backend.exceptions.BadRequestException;
import devPilot.backend.exceptions.NotFoundException;
import devPilot.backend.repository.RepositoryRepository;
import devPilot.backend.services.UserService;
import devPilot.backend.services.ai.RagSettings;
import devPilot.backend.services.github.GitHubRateLimiter;
import devPilot.backend.services.github.GithubApiClient;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Service
@RequiredArgsConstructor
@Slf4j
public class IndexingService {
    private static final int VECTOR_BATCH_SIZE = 32; // smaller batches = smaller bursts against the quota
    private static final int PROGRESS_EVERY_N_FILES = 5;
    private static final int MAX_EMBED_RETRIES = 5;

    // Google's 429 body includes "Please retry in 32.469347819s." — parse it when present.
    private static final Pattern RETRY_DELAY_PATTERN = Pattern.compile("retry in (\\d+(?:\\.\\d+)?)s");

    private final RepositoryRepository repositoryRepository;
    private final UserService userService;
    private final GithubApiClient gitHubApiClient;
    private final CodeFileFilter fileFilter;
    private final CodeChunker codeChunker;
    private final GitHubRateLimiter rateLimiter;
    private final EmbeddingRateLimiter embeddingRateLimiter;
    private final VectorStore vectorStore;

    @Value("${app.indexing.max-file-bytes:102400}")
    private long maxFileBytes;

    public Repository startIndexing(UUID repoId, UUID userId) {
        Repository repo = repositoryRepository.findByIdAndUserId(repoId, userId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));

        if (repo.getIndexStatus() == IndexStatus.INDEXING) {
            throw new BadRequestException("Repository is already being indexed");
        }

        repo.setIndexStatus(IndexStatus.INDEXING);
        repo.setFilesProcessed(0);
        repo.setFilesTotal(0);
        repo.setChunkCount(0);
        repo.setErrorMessage(null);
        repo.setUpdatedAt(Instant.now());
        return repositoryRepository.save(repo);
    }

    @Async("indexingExecutor")
    public void indexAsync(UUID repoId, UUID userId) {
        try {
            doIndex(repoId, userId);
        } catch (Exception ex) {
            log.error("Indexing failed for repo {}", repoId, ex);
            markFailed(repoId, ex.getMessage());
        }
    }

    private void doIndex(UUID repoId, UUID userId) {
        Repository repo = repositoryRepository.findById(repoId)
                .orElseThrow(() -> new NotFoundException("Repository not found"));
        String token = userService.decryptAccessToken(userService.requiredById(userId));

        deleteExistingVectors(repoId.toString());

        Map<String, Object> tree = gitHubApiClient.getRepoTree(
                token, repo.getOwner(), repo.getName(), repo.getDefaultBranch());
        List<String> filePaths = listIndexableFiles(tree);

        updateProgress(repoId, filePaths.size(), 0, 0, IndexStatus.INDEXING, null);

        List<Document> batch = new ArrayList<>();
        int processed = 0;
        int savedChunks = 0;
        int droppedChunks = 0;

        for (String path : filePaths) {
            // Fetching + chunking failures should skip just this file.
            // They must NOT be mixed with embedding failures, which need their own
            // retry path and must never silently drop chunks that are already in `batch`.
            try {
                String content = gitHubApiClient.getFileContent(
                        token, repo.getOwner(), repo.getName(), path);
                List<Document> chunks = codeChunker.chunkFile(repoId.toString(), path, content);
                batch.addAll(chunks);
            } catch (Exception ex) {
                log.warn("Skipping file {} in {}: {}", path, repo.getFullName(), ex.getMessage());
            }

            if (batch.size() >= VECTOR_BATCH_SIZE) {
                int attemptedSize = batch.size();
                int dropped = flushBatch(batch, repo.getFullName());
                droppedChunks += dropped;
                savedChunks += (attemptedSize - dropped);
            }

            processed++;
            if (processed % PROGRESS_EVERY_N_FILES == 0 || processed == filePaths.size()) {
                updateProgress(repoId, filePaths.size(), processed, savedChunks, IndexStatus.INDEXING, null);
            }
            rateLimiter.pause();
        }

        if (!batch.isEmpty()) {
            int attemptedSize = batch.size();
            int dropped = flushBatch(batch, repo.getFullName());
            droppedChunks += dropped;
            savedChunks += (attemptedSize - dropped);
        }

        if (droppedChunks > 0) {
            markFailed(repoId, String.format(
                    "Indexed %d/%d files, but %d chunk(s) could not be embedded after retries and were dropped. "
                            + "This repo's index is INCOMPLETE — re-run indexing to retry.",
                    processed, filePaths.size(), droppedChunks));
        } else {
            markReady(repoId, filePaths.size(), processed, savedChunks, repo.getFullName());
        }
    }

    /**
     * Embeds and stores the given batch, retrying with backoff on 429s instead
     * of dropping the chunks. Clears the batch in place ONLY after a successful add,
     * so a failed attempt never loses data and never gets silently skipped.
     *
     * @return the number of chunks that were permanently dropped (0 on success)
     */
    private int flushBatch(List<Document> batch, String repoFullName) {
        int attempt = 0;
        int size = batch.size();
        while (true) {
            attempt++;
            try {
                embeddingRateLimiter.acquire(batch.size());
                vectorStore.add(batch);
                batch.clear();
                return 0;
            } catch (Exception ex) {
                if (!isRateLimitError(ex)) {
                    // A real bug (bad SQL, bad data, etc.) won't fix itself by waiting.
                    // Fail fast and log the FULL cause chain — the top-level message
                    // (e.g. Spring's "bad SQL grammar") often hides the actual reason.
                    log.error("Non-retryable error flushing batch of {} chunks for {} — giving up immediately",
                            batch.size(), repoFullName, ex);
                    batch.clear();
                    return size;
                }

                if (attempt >= MAX_EMBED_RETRIES) {
                    log.error("Giving up on batch of {} chunks for {} after {} attempts", batch.size(),
                            repoFullName, attempt, ex);
                    batch.clear(); // avoid an infinite retry loop on a batch that can never succeed
                    return size;
                }

                long delayMs = resolveRetryDelayMs(ex, attempt);
                log.warn("Rate limit hit flushing batch of {} chunks for {} (attempt {}/{}): {} — retrying in {} ms",
                        batch.size(), repoFullName, attempt, MAX_EMBED_RETRIES, ex.getMessage(), delayMs);
                sleep(delayMs);
            }
        }
    }

    /**
     * Only 429 / quota-exceeded errors are worth retrying. Everything else
     * (bad SQL, serialization errors, bad data, etc.) is a real bug that
     * retrying will not fix.
     */
    private boolean isRateLimitError(Exception ex) {
        Throwable current = ex;
        while (current != null) {
            String message = current.getMessage();
            if (message != null && (message.contains("429") || message.toLowerCase().contains("quota exceeded"))) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    /**
     * Prefers the server-provided retry delay (Google returns "Please retry in Ns."
     * on 429s) and falls back to exponential backoff otherwise.
     */
    private long resolveRetryDelayMs(Exception ex, int attempt) {
        String message = ex.getMessage();
        if (message != null) {
            Matcher matcher = RETRY_DELAY_PATTERN.matcher(message);
            if (matcher.find()) {
                double seconds = Double.parseDouble(matcher.group(1));
                return (long) (seconds * 1000) + 500; // small buffer on top of Google's suggestion
            }
        }
        // exponential backoff fallback: 2s, 4s, 8s, 16s, 32s
        return (long) (2000 * Math.pow(2, attempt - 1));
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @SuppressWarnings("unchecked")
    private List<String> listIndexableFiles(Map<String, Object> tree) {
        if (tree == null || tree.get("tree") == null) {
            return List.of();
        }

        List<Map<String, Object>> entries = (List<Map<String, Object>>) tree.get("tree");
        return entries.stream()
                .filter(entry -> "blob".equals(String.valueOf(entry.get("type"))))
                .filter(entry -> {
                    String path = String.valueOf(entry.get("path"));
                    long size = entry.get("size") instanceof Number n ? n.longValue() : 0L;
                    return fileFilter.isEligible(path, size, maxFileBytes);
                })
                .map(entry -> String.valueOf(entry.get("path")))
                .toList();
    }

    private void deleteExistingVectors(String repoId) {
        try {
            var filter = new FilterExpressionBuilder().eq(RagSettings.METADATA_REPO_ID, repoId).build();
            vectorStore.delete(filter);
        } catch (Exception ex) {
            log.warn("Could not delete existing vectors for repo {}: {}", repoId, ex.getMessage());
        }
    }

    @Transactional
    protected void updateProgress(
            UUID repoId,
            int total,
            int processed,
            int chunks,
            IndexStatus status,
            String error) {
        repositoryRepository.findById(repoId).ifPresent(repo -> {
            repo.setFilesTotal(total);
            repo.setFilesProcessed(processed);
            repo.setChunkCount(chunks);
            repo.setIndexStatus(status);
            repo.setErrorMessage(error);
            repo.setUpdatedAt(Instant.now());
            repositoryRepository.save(repo);
        });
    }

    @Transactional
    protected void markReady(UUID repoId, int totalFiles, int processedFiles, int totalChunks, String fullName) {
        repositoryRepository.findById(repoId).ifPresent(repo -> {
            repo.setIndexStatus(IndexStatus.READY);
            repo.setFilesTotal(totalFiles);
            repo.setFilesProcessed(processedFiles);
            repo.setChunkCount(totalChunks);
            repo.setIndexedAt(Instant.now());
            repo.setErrorMessage(null);
            repo.setUpdatedAt(Instant.now());
            repositoryRepository.save(repo);
        });
        log.info("Indexed {} files ({} chunks) for {}", processedFiles, totalChunks, fullName);
    }

    @Transactional
    protected void markFailed(UUID repoId, String message) {
        repositoryRepository.findById(repoId).ifPresent(repo -> {
            repo.setIndexStatus(IndexStatus.FAILED);
            repo.setErrorMessage(message != null && message.length() > 2000
                    ? message.substring(0, 2000)
                    : message);
            repo.setUpdatedAt(Instant.now());
            repositoryRepository.save(repo);
        });
    }
}