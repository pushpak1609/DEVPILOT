package devPilot.backend.services.indexing;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import lombok.extern.slf4j.Slf4j;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Simple sliding-window rate limiter for Gemini embedding calls.
 * Free tier quota is 100 embed_content requests/minute — we cap ourselves
 * well under that (default 70/min) to leave headroom for other traffic
 * and avoid clock-skew edge cases.
 *
 * Call acquire(n) with the number of requests you're about to make
 * (e.g. one per document in a batch) BEFORE issuing them. This will
 * block (sleep) as needed to stay under the limit.
 */
@Component
@Slf4j
public class EmbeddingRateLimiter {

    @Value("${app.indexing.embed-requests-per-minute:70}")
    private int maxPerMinute;

    private final Deque<Instant> timestamps = new ArrayDeque<>();
    private final Object lock = new Object();

    public void acquire(int n) {
        for (int i = 0; i < n; i++) {
            acquireOne();
        }
    }

    private void acquireOne() {
        synchronized (lock) {
            Instant now = Instant.now();
            Instant windowStart = now.minus(Duration.ofMinutes(1));

            // drop timestamps older than the rolling window
            while (!timestamps.isEmpty() && timestamps.peekFirst().isBefore(windowStart)) {
                timestamps.pollFirst();
            }

            if (timestamps.size() >= maxPerMinute) {
                Instant oldest = timestamps.peekFirst();
                Duration waitTime = Duration.between(now, oldest.plus(Duration.ofMinutes(1)))
                        .plusMillis(50); // small buffer
                if (!waitTime.isNegative()) {
                    log.debug("Embedding rate limit reached ({} req/min) — pausing {} ms",
                            maxPerMinute, waitTime.toMillis());
                    sleep(waitTime.toMillis());
                }
                // re-evaluate window after sleeping
                Instant newNow = Instant.now();
                Instant newWindowStart = newNow.minus(Duration.ofMinutes(1));
                while (!timestamps.isEmpty() && timestamps.peekFirst().isBefore(newWindowStart)) {
                    timestamps.pollFirst();
                }
            }

            timestamps.addLast(Instant.now());
        }
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
