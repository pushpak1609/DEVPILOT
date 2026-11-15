// DevPilot answer quality check. No dependencies, needs Node 18+.
//
// Sends a fixed list of questions about the indexed repo, one at a time (with a gap, to stay under
// the Groq per-minute budget), and records for each question:
//   - retrievalHit:   was the expected file among the citations returned by the backend?
//   - answerMentions: does the answer text mention the expected file name?
// It also saves every answer to quality-<LABEL>.md so you can read two runs side by side.
//
// Usage (PowerShell, in the loadtest folder):
//   $env:COOKIE="<DEVPILOT_SESSION value>"
//   $env:REPO_ID="<uuid of the indexed repository>"
//   $env:LABEL="low"
//   node quality-check.mjs
//
// Never commit your cookie. It is only read from environment variables.

import { writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const COOKIE = process.env.COOKIE;
const REPO_ID = process.env.REPO_ID;
const LABEL = process.env.LABEL ?? "quality";
const GAP_MS = Number(process.env.GAP_MS ?? 15000);

if (!COOKIE || !REPO_ID) {
  console.error("Set COOKIE (DEVPILOT_SESSION value) and REPO_ID environment variables first.");
  process.exit(1);
}

// EDIT THIS LIST for the repository you indexed.
// expected = part of a file name that SHOULD show up in the citations for that question.
// Only use files that existed when the repository was indexed.
const CASES = [
  { q: "How is the SSE chat streaming implemented?", expected: "ChatStreamHandler" },
  { q: "How is authentication and security configured?", expected: "SecurityConfig" },
  { q: "How does retrieval of code chunks from the vector store work?", expected: "CodeContextRetriever" },
  { q: "What system prompt does the assistant use?", expected: "ChatPromptBuilder" },
  { q: "Which endpoint is used to send a chat message?", expected: "ChatController" },
  { q: "How many chunks are retrieved per question?", expected: "RagSettings" },
  { q: "How does the frontend decide which backend URL to call?", expected: "api.ts" },
  { q: "How are chat sessions created, and what must be true about the repository?", expected: "ChatService" },
];

const headers = { "Content-Type": "application/json", Cookie: `DEVPILOT_SESSION=${COOKIE}` };
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

// Sends one question and returns the final assistant_message event (content + citations).
async function ask(sessionId, content) {
  const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { ...headers, Accept: "text/event-stream" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let answer = null;
  let error = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split("\n");
      const eventName = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .join("\n");
      if (eventName === "assistant_message") {
        try {
          answer = JSON.parse(data);
        } catch {
          error = "could not parse assistant_message";
        }
      } else if (eventName === "error") {
        error = "error event from server";
      }
    }
  }
  return answer ? { answer } : { error: error ?? "no assistant_message received" };
}

async function main() {
  console.log(`Quality check | label=${LABEL} | ${CASES.length} questions, ${GAP_MS / 1000}s gap`);
  const session = await api("/api/chat/sessions", "POST", {
    repositoryId: REPO_ID,
    title: `quality-${LABEL}`,
  });

  const rows = [];
  try {
    for (const [i, c] of CASES.entries()) {
      const r = await ask(session.id, c.q);
      const text = r.answer?.content ?? "";
      const citationsText = JSON.stringify(r.answer?.citations ?? []).toLowerCase();
      const key = c.expected.toLowerCase();
      const row = {
        question: c.q,
        expected: c.expected,
        error: r.error ?? null,
        retrievalHit: citationsText.includes(key),
        answerMentions: text.toLowerCase().includes(key),
        answerChars: text.length,
        answer: text,
      };
      rows.push(row);
      console.log(
        `${i + 1}/${CASES.length} ${row.error ? "ERROR " + row.error : ""} retrieval=${row.retrievalHit ? "hit" : "MISS"} mentions=${row.answerMentions ? "yes" : "no"} chars=${row.answerChars} | ${c.q}`
      );
      if (i < CASES.length - 1) await sleep(GAP_MS);
    }
  } finally {
    await api(`/api/chat/sessions/${session.id}`, "DELETE").catch(() => {});
  }

  const ok = rows.filter((r) => !r.error);
  const summary = {
    label: LABEL,
    questions: rows.length,
    errors: rows.length - ok.length,
    retrievalHits: rows.filter((r) => r.retrievalHit).length,
    answerMentionsExpected: rows.filter((r) => r.answerMentions).length,
    avgAnswerChars: ok.length ? Math.round(ok.reduce((a, r) => a + r.answerChars, 0) / ok.length) : 0,
  };
  console.log(summary);

  writeFileSync(`quality-${LABEL}.json`, JSON.stringify({ summary, rows }, null, 2));
  const md = [
    `# Quality check: ${LABEL}`,
    "",
    JSON.stringify(summary),
    "",
    ...rows.map(
      (r, i) =>
        `## ${i + 1}. ${r.question}\n\nExpected file: ${r.expected} | retrieval: ${r.retrievalHit ? "hit" : "MISS"} | answer mentions it: ${r.answerMentions ? "yes" : "no"}\n\n${r.error ? "ERROR: " + r.error : r.answer}\n`
    ),
  ].join("\n");
  writeFileSync(`quality-${LABEL}.md`, md);
  console.log(`Saved quality-${LABEL}.json and quality-${LABEL}.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
