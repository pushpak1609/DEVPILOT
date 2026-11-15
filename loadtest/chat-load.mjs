// DevPilot chat load test (SSE aware). No dependencies, needs Node 18+.
//
// Usage (PowerShell):
//   $env:COOKIE="<DEVPILOT_SESSION value>"
//   $env:REPO_ID="<uuid of an indexed (READY) repository>"
//   $env:LABEL="before"; $env:USERS="1"; $env:MESSAGES="5"
//   node chat-load.mjs
//
// Never commit your cookie. It is only read from environment variables.

import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const COOKIE = process.env.COOKIE;
const REPO_ID = process.env.REPO_ID;
const USERS = Number(process.env.USERS ?? 1); // concurrent virtual users
const MESSAGES = Number(process.env.MESSAGES ?? 3); // messages per user, sent one after another
const THINK_MS = Number(process.env.THINK_MS ?? 0); // pause between a user's messages
const RAMP_MS = Number(process.env.RAMP_MS ?? 300); // delay between user start times
const LABEL = process.env.LABEL ?? "run"; // e.g. before / after-hnsw
const TIMEOUT_MS = 120_000;

if (!COOKIE || !REPO_ID) {
  console.error("Set COOKIE (DEVPILOT_SESSION value) and REPO_ID environment variables first.");
  process.exit(1);
}
if (USERS * MESSAGES > 60 && !process.env.FORCE) {
  console.error(
    `USERS x MESSAGES = ${USERS * MESSAGES} real Gemini + Groq calls. Set FORCE=1 if you really want that.`
  );
  process.exit(1);
}

// Generic questions that make sense for most repositories.
const QUESTIONS = [
  "What does this project do?",
  "Where is the application entry point?",
  "How is authentication handled?",
  "Which database does this project use and how is it configured?",
  "Explain the overall project structure.",
  "How are errors handled in this codebase?",
  "Which external APIs or services does this project call?",
  "How is configuration loaded?",
  "What are the main classes or modules and what do they do?",
  "How would I run this project locally?",
];

const headers = { "Content-Type": "application/json", Cookie: `DEVPILOT_SESSION=${COOKIE}` };
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method, body) {
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Sends one chat message and reads the SSE stream, timing the interesting events.
async function sendMessage(sessionId, content) {
  const m = { ok: false, status: 0, headersMs: null, ttft: null, e2e: null, tokens: 0, error: null };
  const t0 = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify({ content }),
      signal: ctrl.signal,
    });
    m.status = res.status;
    // The backend returns headers only after DB lookups + retrieval (embedding + pgvector search),
    // so this is a good proxy for "everything before the LLM starts".
    m.headersMs = now() - t0;
    if (!res.ok) {
      m.error = `HTTP ${res.status}`;
      return m;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const t = now();
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventName = raw
          .split("\n")
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        if (eventName === "token") {
          m.tokens++;
          if (m.ttft === null) m.ttft = t - t0; // time to first token
        } else if (eventName === "assistant_message") {
          m.e2e = t - t0; // answer fully generated and saved
        } else if (eventName === "error") {
          m.error = "error event from server";
        }
      }
    }
    m.ok = !m.error && m.e2e !== null;
    if (!m.ok && !m.error) m.error = "stream ended without assistant_message";
  } catch (e) {
    m.error = e.name === "AbortError" ? "timeout" : e.message;
  } finally {
    clearTimeout(timer);
  }
  return m;
}

async function virtualUser(id, results) {
  await sleep(id * RAMP_MS);
  const session = await api("/api/chat/sessions", "POST", {
    repositoryId: REPO_ID,
    title: `loadtest-${LABEL}-${id}`,
  });
  try {
    for (let i = 0; i < MESSAGES; i++) {
      const question = QUESTIONS[(id * MESSAGES + i) % QUESTIONS.length];
      results.push(await sendMessage(session.id, question));
      if (THINK_MS) await sleep(THINK_MS);
    }
  } finally {
    await api(`/api/chat/sessions/${session.id}`, "DELETE").catch(() => {});
  }
}

function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const fmt = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : "-");

async function main() {
  console.log(`Target ${BASE} | users=${USERS} messages/user=${MESSAGES} | label=${LABEL}`);

  // Warm-up (JVM, connection pool, Gemini/Groq connections). Not counted.
  const warm = await api("/api/chat/sessions", "POST", { repositoryId: REPO_ID, title: "loadtest-warmup" });
  const warmResult = await sendMessage(warm.id, QUESTIONS[0]);
  await api(`/api/chat/sessions/${warm.id}`, "DELETE").catch(() => {});
  if (!warmResult.ok) {
    console.error(`Warm-up request failed (${warmResult.error}). Check COOKIE, REPO_ID and that the stack is running.`);
    process.exit(1);
  }

  const results = [];
  const wallStart = now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => virtualUser(i, results)));
  const wallSec = (now() - wallStart) / 1000;

  const ok = results.filter((r) => r.ok);
  const col = (fn) => ok.map(fn).filter(Number.isFinite);
  const metrics = {
    "before LLM: headers (ms)": col((r) => r.headersMs),
    "TTFT (ms)": col((r) => r.ttft),
    "end-to-end (ms)": col((r) => r.e2e),
    "inter-token (ms)": col((r) => (r.tokens > 1 ? (r.e2e - r.ttft) / (r.tokens - 1) : NaN)),
    "stream chunks/s per request": col((r) => (r.tokens > 1 ? r.tokens / ((r.e2e - r.ttft) / 1000) : NaN)),
  };

  const rows = Object.entries(metrics).map(([metric, arr]) => ({
    metric,
    p50: fmt(percentile(arr, 50)),
    p95: fmt(percentile(arr, 95)),
    p99: fmt(percentile(arr, 99)),
    avg: fmt(arr.reduce((a, b) => a + b, 0) / arr.length),
    max: fmt(Math.max(...arr)),
  }));
  console.table(rows);

  const errors = {};
  for (const r of results.filter((x) => !x.ok)) errors[r.error] = (errors[r.error] ?? 0) + 1;
  const summary = {
    requests: results.length,
    succeeded: ok.length,
    failed: results.length - ok.length,
    errors,
    wallSeconds: Math.round(wallSec * 10) / 10,
    successfulRequestsPerSecond: Math.round((ok.length / wallSec) * 100) / 100,
  };
  console.log(summary);
  if (results.length < 100) {
    console.log("Note: with fewer than ~100 requests, P95/P99 are close to the maximum value.");
  }

  const file = `results-${LABEL}-${USERS}u.json`;
  writeFileSync(file, JSON.stringify({ config: { BASE, USERS, MESSAGES, LABEL }, summary, rows, results }, null, 2));
  console.log(`Saved ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
