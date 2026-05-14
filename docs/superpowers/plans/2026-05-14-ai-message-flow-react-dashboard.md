# AI Message Flow + React Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild message capture, AI moderation analysis, split APIs, and dashboard UI into a fast async backend plus React/Vite frontend.

**Architecture:** Keep Discord capture fast by writing messages and enqueueing async analysis. Split backend modules into store, typed broadcaster, conversation context, queue, LLM client, and focused route files. Replace the static inline dashboard with a React/Vite app served by Express.

**Tech Stack:** TypeScript, Node.js, Express, Drizzle ORM, Vitest, React, Vite, WebSocket, pnpm.

---

## File Structure

### Backend

- Modify `src/moderation/types.ts` — shared message, query, analysis, and WebSocket event types.
- Create `src/moderation/broadcaster.ts` — typed WebSocket broadcaster and event fanout.
- Modify `src/webserver.ts` — server bootstrap only; register route modules and broadcaster.
- Create `src/routes/messageRoutes.ts` — message/attachment/review read APIs.
- Create `src/routes/analysisRoutes.ts` — reanalysis and queue status APIs.
- Create `src/routes/syncRoutes.ts` — backlog sync API.
- Create `src/routes/uiStateRoutes.ts` — UI state API.
- Create `src/routes/voiceRoutes.ts` — guild/channel/connect voice APIs.
- Modify `src/moderation/messageStore.ts` — repository functions, cursor pagination, review queries, pending claims.
- Create `src/moderation/conversationContext.ts` — context selection for AI prompts.
- Create `src/moderation/llmModerationClient.ts` — LLM request and strict response validation.
- Replace `src/moderation/aiAnalyzer.ts` internals — debounce queue that uses context/client/store.
- Modify `src/moderation/messageCapture.ts` — narrow ingestion and queue by conversation.
- Modify `src/moderation/backlogSync.ts` — sync feeds same capture/queue path.
- Modify `src/database/schema.ts` — add indexes and optional `ai_analysis_runs` table.

### Tests

- Create `tests/moderation/conversationContext.test.ts`.
- Create `tests/moderation/llmModerationClient.test.ts`.
- Create `tests/moderation/analysisQueue.test.ts`.
- Create `tests/moderation/messageStoreQueries.test.ts`.
- Update `tests/smoke.test.ts` if package scripts/build paths change.

### Frontend

- Create `frontend/package.json` only if workspace split is chosen; otherwise add Vite deps/scripts to root `package.json`.
- Create `frontend/index.html`.
- Create `frontend/src/main.tsx`.
- Create `frontend/src/App.tsx`.
- Create `frontend/src/api/client.ts`.
- Create `frontend/src/ws/client.ts`.
- Create `frontend/src/state/useMessages.ts`.
- Create `frontend/src/state/useReviewQueue.ts`.
- Create `frontend/src/state/useVoiceState.ts`.
- Create `frontend/src/components/layout/Shell.tsx`.
- Create `frontend/src/components/messages/MessageFeed.tsx`.
- Create `frontend/src/components/messages/MessageCard.tsx`.
- Create `frontend/src/components/review/ReviewPanel.tsx`.
- Create `frontend/src/components/voice/VoiceControls.tsx`.
- Create `frontend/src/styles.css`.
- Modify `package.json` — add React/Vite deps and scripts.
- Modify `tsconfig.json` or add `frontend/tsconfig.json`.

---

## Task 1: Typed moderation contracts and broadcaster

**Files:**
- Modify: `src/moderation/types.ts`
- Create: `src/moderation/broadcaster.ts`
- Test: `tests/moderation/broadcaster.test.ts`

- [ ] **Step 1: Write broadcaster tests**

Create `tests/moderation/broadcaster.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBroadcaster } from "../../src/moderation/broadcaster";

function client() {
  return { readyState: 1, send: vi.fn() };
}

describe("createBroadcaster", () => {
  it("sends JSON events to open clients", () => {
    const ws = client();
    const broadcaster = createBroadcaster();

    broadcaster.addClient(ws as any);
    broadcaster.messageAnalyzed({ id: "m1", ai_status: "clean" } as any);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "message_analyzed",
      data: { id: "m1", ai_status: "clean" },
    });
  });

  it("skips closed clients", () => {
    const ws = { readyState: 3, send: vi.fn() };
    const broadcaster = createBroadcaster();

    broadcaster.addClient(ws as any);
    broadcaster.messageDeleted({ id: "m1", deleted_at: 123 });

    expect(ws.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/moderation/broadcaster.test.ts`

Expected: FAIL because `src/moderation/broadcaster.ts` does not exist.

- [ ] **Step 3: Extend shared types**

Add to `src/moderation/types.ts`:

```ts
export type AIStatus = "pending" | "clean" | "warn" | "flagged" | "error";

export interface MessageQuery {
  guildId?: string;
  channelId?: string;
  threadId?: string;
  status?: AIStatus[];
  userId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}

export interface AnalysisResult {
  messageId: string;
  status: Exclude<AIStatus, "pending" | "error">;
  flags: string[];
  score: number;
  analysis: string;
}

export type ModerationWsEvent =
  | { type: "ui_state"; state: unknown }
  | { type: "user_state"; users: unknown[] }
  | { type: "message_created"; data: MessageRecord }
  | { type: "message_updated"; data: Partial<MessageRecord> & { id: string } }
  | { type: "message_deleted"; data: { id: string; deleted_at: number } }
  | { type: "message_analyzed"; data: MessageRecord }
  | { type: "attachment_created"; data: AttachmentRecord }
  | { type: "analysis_queue_status"; data: AnalysisQueueStatus };

export interface AnalysisQueueStatus {
  queuedConversations: number;
  activeRequests: number;
  lastError: string | null;
}
```

- [ ] **Step 4: Create typed broadcaster**

Create `src/moderation/broadcaster.ts`:

```ts
import type { WebSocket } from "ws";
import type {
  AnalysisQueueStatus,
  AttachmentRecord,
  MessageRecord,
  ModerationWsEvent,
} from "./types";

type ClientLike = Pick<WebSocket, "readyState" | "send">;

function sendJson(clients: Set<ClientLike>, event: ModerationWsEvent): void {
  const payload = JSON.stringify({ ...event, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

export function createBroadcaster() {
  const clients = new Set<ClientLike>();

  return {
    addClient(client: ClientLike) {
      clients.add(client);
    },
    removeClient(client: ClientLike) {
      clients.delete(client);
    },
    clientCount() {
      return clients.size;
    },
    uiState(state: unknown) {
      sendJson(clients, { type: "ui_state", state });
    },
    userState(users: unknown[]) {
      sendJson(clients, { type: "user_state", users });
    },
    messageCreated(data: MessageRecord) {
      sendJson(clients, { type: "message_created", data });
    },
    messageUpdated(data: Partial<MessageRecord> & { id: string }) {
      sendJson(clients, { type: "message_updated", data });
    },
    messageDeleted(data: { id: string; deleted_at: number }) {
      sendJson(clients, { type: "message_deleted", data });
    },
    messageAnalyzed(data: MessageRecord) {
      sendJson(clients, { type: "message_analyzed", data });
    },
    attachmentCreated(data: AttachmentRecord) {
      sendJson(clients, { type: "attachment_created", data });
    },
    analysisQueueStatus(data: AnalysisQueueStatus) {
      sendJson(clients, { type: "analysis_queue_status", data });
    },
  };
}

export type ModerationBroadcaster = ReturnType<typeof createBroadcaster>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/moderation/broadcaster.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/moderation/types.ts src/moderation/broadcaster.ts tests/moderation/broadcaster.test.ts
git commit -m "feat: add typed moderation broadcaster"
```

---

## Task 2: Cursor helpers and message store query API

**Files:**
- Modify: `src/moderation/messageStore.ts`
- Test: `tests/moderation/messageStoreQueries.test.ts`

- [ ] **Step 1: Write cursor pagination tests**

Create `tests/moderation/messageStoreQueries.test.ts` with database mocking pattern used by existing tests. Use this behavioral test for cursor encoding functions exported from `messageStore.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/moderation/messageStore";

describe("message cursor helpers", () => {
  it("round-trips created_at and id", () => {
    const cursor = encodeCursor({ created_at: 1710000000000, id: "abc" });
    expect(decodeCursor(cursor)).toEqual({ created_at: 1710000000000, id: "abc" });
  });

  it("returns null for invalid cursor", () => {
    expect(decodeCursor("not-base64-json")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/moderation/messageStoreQueries.test.ts`

Expected: FAIL because cursor helpers are missing.

- [ ] **Step 3: Add cursor helpers and query interfaces**

Add to `src/moderation/messageStore.ts` near the top:

```ts
import { lt, sql } from "drizzle-orm";
import type { AIStatus, MessageQuery, PageResult } from "./types";

interface CursorValue {
  created_at: number;
  id: string;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor?: string): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed.created_at !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
```

Adjust imports to avoid duplicates: existing `drizzle-orm` import becomes:

```ts
import { and, asc, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
```

If SQLite typechecking rejects `ilike`, use `sql` search in implementation below.

- [ ] **Step 4: Add `listMessages` and `listReviewMessages`**

Add to `src/moderation/messageStore.ts` after existing read functions:

```ts
function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(limit || 50, 100));
}

function statusesOrDefault(status?: AIStatus[]): AIStatus[] | undefined {
  return status && status.length > 0 ? status : undefined;
}

export async function listMessages(
  query: MessageQuery,
): Promise<PageResult<MessageRecord>> {
  const db = getDatabase() as any;
  const limit = normalizeLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const filters = [];

  if (query.guildId) filters.push(eq(messagesTable.guild_id, query.guildId));
  if (query.channelId) filters.push(eq(messagesTable.channel_id, query.channelId));
  if (query.threadId) filters.push(eq(messagesTable.thread_id, query.threadId));
  if (query.userId) filters.push(eq(messagesTable.user_id, query.userId));
  if (cursor) filters.push(lt(messagesTable.created_at, cursor.created_at));
  if (query.q) {
    const pattern = `%${query.q.toLowerCase()}%`;
    filters.push(sql`lower(${messagesTable.content}) like ${pattern}`);
  }

  const status = statusesOrDefault(query.status);
  if (status) filters.push(sql`${messagesTable.ai_status} in ${status}`);

  const rows = await db
    .select()
    .from(messagesTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(messagesTable.created_at), desc(messagesTable.id))
    .limit(limit + 1);

  const data = rows.slice(0, limit) as MessageRecord[];
  const next = rows.length > limit ? data[data.length - 1] : null;
  return {
    data,
    nextCursor: next
      ? encodeCursor({ created_at: next.created_at, id: next.id })
      : null,
  };
}

export async function listReviewMessages(query: {
  guildId?: string;
  channelId?: string;
  status?: AIStatus[];
  cursor?: string;
  limit: number;
}): Promise<PageResult<MessageRecord>> {
  return listMessages({
    guildId: query.guildId,
    channelId: query.channelId,
    status: query.status ?? ["warn", "flagged", "error"],
    cursor: query.cursor,
    limit: query.limit,
  });
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run tests/moderation/messageStoreQueries.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck and fix query typing**

Run: `pnpm run typecheck`

Expected: PASS. If `sql in ${status}` fails for dialect typing, replace with explicit `or(...status.map((item) => eq(messagesTable.ai_status, item)))`.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/moderation/messageStore.ts tests/moderation/messageStoreQueries.test.ts
git commit -m "feat: add cursor-based message queries"
```

---

## Task 3: Conversation context builder

**Files:**
- Create: `src/moderation/conversationContext.ts`
- Modify: `src/moderation/messageStore.ts`
- Test: `tests/moderation/conversationContext.test.ts`

- [ ] **Step 1: Write context builder tests**

Create `tests/moderation/conversationContext.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildConversationPromptMessages } from "../../src/moderation/conversationContext";
import type { MessageRecord } from "../../src/moderation/types";

function message(id: string, content: string, created_at: number): MessageRecord {
  return {
    id,
    guild_id: "g1",
    channel_id: "c1",
    thread_id: null,
    user_id: `u-${id}`,
    username: `user-${id}`,
    avatar_url: null,
    content,
    edited_content: null,
    created_at,
    edited_at: null,
    deleted_at: null,
    type: "text",
    metadata: null,
    ai_status: "pending",
  };
}

describe("buildConversationPromptMessages", () => {
  it("marks target messages and keeps chronological order", () => {
    const lines = buildConversationPromptMessages({
      contextBefore: [message("a", "hello", 1)],
      targets: [message("b", "bad?", 2)],
      maxTokens: 1000,
    });

    expect(lines).toContain("[context] id=a time=1970-01-01T00:00:00.001Z user=user-a: hello");
    expect(lines).toContain("[target] id=b time=1970-01-01T00:00:00.002Z user=user-b: bad?");
    expect(lines.indexOf("id=a")).toBeLessThan(lines.indexOf("id=b"));
  });

  it("uses edited content when present", () => {
    const target = message("b", "original", 2);
    target.edited_content = "edited";

    const lines = buildConversationPromptMessages({
      contextBefore: [],
      targets: [target],
      maxTokens: 1000,
    });

    expect(lines).toContain("edited");
    expect(lines).not.toContain("original");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/moderation/conversationContext.test.ts`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement prompt context builder**

Create `src/moderation/conversationContext.ts`:

```ts
import type { MessageRecord } from "./types";

export interface ConversationContextInput {
  contextBefore: MessageRecord[];
  targets: MessageRecord[];
  maxTokens: number;
}

function textOf(message: MessageRecord): string {
  return (message.edited_content || message.content || "").trim();
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatLine(kind: "context" | "target", message: MessageRecord): string {
  return `[${kind}] id=${message.id} time=${new Date(message.created_at).toISOString()} user=${message.username}: ${textOf(message)}`;
}

export function buildConversationPromptMessages(
  input: ConversationContextInput,
): string {
  const targets = [...input.targets].sort((a, b) => a.created_at - b.created_at);
  const contextBefore = [...input.contextBefore].sort(
    (a, b) => a.created_at - b.created_at,
  );

  const targetLines = targets.map((message) => formatLine("target", message));
  const targetTokens = targetLines.reduce((sum, line) => sum + estimateTokens(line), 0);
  const contextBudget = Math.max(0, input.maxTokens - targetTokens);

  const selectedContext: string[] = [];
  let used = 0;
  for (const message of [...contextBefore].reverse()) {
    const line = formatLine("context", message);
    const tokens = estimateTokens(line);
    if (used + tokens > contextBudget) break;
    selectedContext.unshift(line);
    used += tokens;
  }

  return [...selectedContext, ...targetLines].join("\n");
}
```

- [ ] **Step 4: Add store query for prior context**

Add to `src/moderation/messageStore.ts`:

```ts
export async function getConversationContextBefore(input: {
  channelId: string;
  threadId: string | null;
  beforeCreatedAt: number;
  limit: number;
}): Promise<MessageRecord[]> {
  const db = getDatabase() as any;
  const locationFilter = input.threadId
    ? eq(messagesTable.thread_id, input.threadId)
    : eq(messagesTable.channel_id, input.channelId);

  const rows = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        locationFilter,
        lt(messagesTable.created_at, input.beforeCreatedAt),
        isNull(messagesTable.deleted_at),
      ),
    )
    .orderBy(desc(messagesTable.created_at))
    .limit(input.limit);

  return [...(rows as MessageRecord[])].reverse();
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/moderation/conversationContext.test.ts tests/moderation/messageStoreQueries.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/moderation/conversationContext.ts src/moderation/messageStore.ts tests/moderation/conversationContext.test.ts
git commit -m "feat: add conversation context builder"
```

---

## Task 4: Strict LLM moderation client

**Files:**
- Create: `src/moderation/llmModerationClient.ts`
- Modify: `src/moderation/types.ts`
- Test: `tests/moderation/llmModerationClient.test.ts`

- [ ] **Step 1: Write parser tests**

Create `tests/moderation/llmModerationClient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseModerationResponse } from "../../src/moderation/llmModerationClient";

describe("parseModerationResponse", () => {
  it("parses valid keyed results", () => {
    const result = parseModerationResponse(
      JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "warn",
            flags: ["provokasi"],
            score: 0.7,
            analysis: "Perlu peringatan.",
          },
        ],
      }),
      ["m1"],
    );

    expect(result).toEqual([
      {
        messageId: "m1",
        status: "warn",
        flags: ["provokasi"],
        score: 0.7,
        analysis: "Perlu peringatan.",
      },
    ]);
  });

  it("rejects missing target ids", () => {
    expect(() =>
      parseModerationResponse(JSON.stringify({ results: [] }), ["m1"]),
    ).toThrow(/missing/i);
  });

  it("rejects unknown ids", () => {
    expect(() =>
      parseModerationResponse(
        JSON.stringify({
          results: [{ message_id: "m2", status: "clean", flags: [], score: 0, analysis: "OK" }],
        }),
        ["m1"],
      ),
    ).toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/moderation/llmModerationClient.test.ts`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement parser and client skeleton**

Create `src/moderation/llmModerationClient.ts`:

```ts
import { config } from "../config";
import { createChildLogger } from "../logger";
import { retryWithBackoff } from "../retry";
import type { AnalysisResult, MessageRecord } from "./types";

const logger = createChildLogger("llm-moderation-client");

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

function extractJsonObject(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("LLM response does not contain JSON object");
  return JSON.parse(content.slice(start, end + 1));
}

function normalizeStatus(value: unknown): AnalysisResult["status"] {
  if (value === "clean" || value === "warn" || value === "flagged") return value;
  throw new Error(`Invalid moderation status: ${String(value)}`);
}

export function parseModerationResponse(
  content: string,
  targetIds: string[],
): AnalysisResult[] {
  const parsed = extractJsonObject(content) as { results?: unknown[] };
  if (!Array.isArray(parsed.results)) throw new Error("LLM response missing results array");

  const targets = new Set(targetIds);
  const seen = new Set<string>();
  const results = parsed.results.map((item) => {
    const row = item as Record<string, unknown>;
    const messageId = String(row.message_id || "");
    if (!targets.has(messageId)) throw new Error(`LLM response contains unknown message id: ${messageId}`);
    seen.add(messageId);

    const score = Number(row.score);
    if (!Number.isFinite(score)) throw new Error(`Invalid moderation score for ${messageId}`);

    return {
      messageId,
      status: normalizeStatus(row.status),
      flags: Array.isArray(row.flags) ? row.flags.map(String) : [],
      score: Math.max(0, Math.min(1, score)),
      analysis: typeof row.analysis === "string" ? row.analysis : "Tidak ada analisis.",
    };
  });

  const missing = targetIds.filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`LLM response missing target ids: ${missing.join(", ")}`);

  return results;
}

export async function runModerationAnalysis(input: {
  targets: MessageRecord[];
  contextText: string;
}): Promise<{ results: AnalysisResult[]; raw: unknown }> {
  const targetIds = input.targets.map((message) => message.id);
  const response = (await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.AI_ANALYSIS_TIMEOUT_MS);
      try {
        const res = await fetch(`${config.AI_LLM_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.AI_LLM_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.AI_LLM_MODEL,
            messages: [
              {
                role: "system",
                content:
                  "Kamu moderator Discord komunitas. Nilai hanya pesan bertanda [target]. Gunakan konteks untuk memahami alur. Balas JSON object: {\"results\":[{\"message_id\":\"...\",\"status\":\"clean|warn|flagged\",\"flags\":[\"...\"],\"score\":0..1,\"analysis\":\"Bahasa Indonesia: alasan dan aksi disarankan\"}]}. Semua target id wajib ada.",
              },
              { role: "user", content: input.contextText },
            ],
            temperature: 0.2,
          }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`AI request failed (${res.status}): ${text.slice(0, 500)}`);
        return JSON.parse(text) as ChatCompletionResponse;
      } finally {
        clearTimeout(timeout);
      }
    },
    { retries: 2, logger },
  )) as ChatCompletionResponse;

  const content = response.choices?.[0]?.message?.content?.trim() || "";
  return { results: parseModerationResponse(content, targetIds), raw: response };
}
```

- [ ] **Step 4: Run parser tests**

Run: `pnpm vitest run tests/moderation/llmModerationClient.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/moderation/llmModerationClient.ts tests/moderation/llmModerationClient.test.ts
git commit -m "feat: add strict llm moderation client"
```

---

## Task 5: Debounced analysis queue

**Files:**
- Replace internals: `src/moderation/aiAnalyzer.ts`
- Modify: `src/moderation/messageStore.ts`
- Test: `tests/moderation/analysisQueue.test.ts`

- [ ] **Step 1: Write pure queue helper test**

Create `tests/moderation/analysisQueue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getConversationKey, pickBatchWithinBudget } from "../../src/moderation/aiAnalyzer";
import type { MessageRecord } from "../../src/moderation/types";

function message(id: string, content: string, thread_id: string | null = null): MessageRecord {
  return {
    id,
    guild_id: "g1",
    channel_id: "c1",
    thread_id,
    user_id: "u1",
    username: "u1",
    avatar_url: null,
    content,
    edited_content: null,
    created_at: Number(id.replace("m", "")) || 1,
    edited_at: null,
    deleted_at: null,
    type: "text",
    metadata: null,
    ai_status: "pending",
  };
}

describe("analysis queue helpers", () => {
  it("uses thread id before channel id", () => {
    expect(getConversationKey(message("m1", "hello", "t1"))).toBe("t1");
    expect(getConversationKey(message("m1", "hello", null))).toBe("c1");
  });

  it("picks batch within budget", () => {
    const batch = pickBatchWithinBudget([message("m1", "a"), message("m2", "x".repeat(1000))], 50, 10);
    expect(batch.map((item) => item.id)).toEqual(["m1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/moderation/analysisQueue.test.ts`

Expected: FAIL because helpers are missing.

- [ ] **Step 3: Add store functions for pending analysis**

Add to `src/moderation/messageStore.ts`:

```ts
export async function getPendingMessagesByConversation(
  conversationKey: string,
  limit: number,
): Promise<MessageRecord[]> {
  const db = getDatabase() as any;
  const rows = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.ai_status, "pending"),
        isNull(messagesTable.deleted_at),
        or(
          eq(messagesTable.channel_id, conversationKey),
          eq(messagesTable.thread_id, conversationKey),
        ),
      ),
    )
    .orderBy(asc(messagesTable.created_at))
    .limit(limit);

  return rows as MessageRecord[];
}

export async function getPendingConversationKeys(limit: number): Promise<string[]> {
  const pending = await getPendingAIAnalysisMessages(limit);
  return Array.from(new Set(pending.map((message) => message.thread_id || message.channel_id)));
}
```

- [ ] **Step 4: Replace `aiAnalyzer.ts` queue internals**

Rewrite `src/moderation/aiAnalyzer.ts` around these exports while preserving public functions `queueMessageAnalysis` and `startPendingAIAnalysisWorker`:

```ts
import { config } from "../config";
import { createChildLogger } from "../logger";
import { buildConversationPromptMessages } from "./conversationContext";
import { runModerationAnalysis } from "./llmModerationClient";
import {
  getConversationContextBefore,
  getMessageById,
  getPendingConversationKeys,
  getPendingMessagesByConversation,
  updateMessageAIAnalysis,
} from "./messageStore";
import type { MessageRecord } from "./types";

const logger = createChildLogger("ai-analyzer");
const queuedConversations = new Set<string>();
const debounceTimers = new Map<string, NodeJS.Timeout>();
let activeRequests = 0;
let lastError: string | null = null;

const MAX_ACTIVE_REQUESTS = 1;
const MAX_BATCH_MESSAGES = 40;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_PROMPT_TOKENS = 9_000;
const DEBOUNCE_MS = 1500;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageText(message: MessageRecord): string {
  return (message.edited_content || message.content || "").trim();
}

export function getConversationKey(message: MessageRecord): string {
  return message.thread_id || message.channel_id;
}

export function pickBatchWithinBudget(
  messages: MessageRecord[],
  tokenBudget: number,
  maxMessages: number,
): MessageRecord[] {
  const batch: MessageRecord[] = [];
  let used = 0;
  for (const message of messages) {
    const tokens = estimateTokens(messageText(message)) + 32;
    if (batch.length > 0 && (batch.length >= maxMessages || used + tokens > tokenBudget)) break;
    batch.push(message);
    used += tokens;
  }
  return batch;
}

async function analyzeConversation(conversationKey: string): Promise<void> {
  if (!config.AI_ANALYSIS_ENABLED) return;
  if (activeRequests >= MAX_ACTIVE_REQUESTS) {
    queuedConversations.add(conversationKey);
    setTimeout(() => drainQueue().catch((error) => logger.error({ error }, "AI queue drain failed")), 250);
    return;
  }

  activeRequests++;
  try {
    const pending = await getPendingMessagesByConversation(conversationKey, MAX_BATCH_MESSAGES);
    const batch = pickBatchWithinBudget(pending, MAX_PROMPT_TOKENS, MAX_BATCH_MESSAGES);
    if (batch.length === 0) return;

    const first = batch[0];
    const contextBefore = await getConversationContextBefore({
      channelId: first.channel_id,
      threadId: first.thread_id,
      beforeCreatedAt: first.created_at,
      limit: MAX_CONTEXT_MESSAGES,
    });
    const contextText = buildConversationPromptMessages({
      contextBefore,
      targets: batch,
      maxTokens: MAX_PROMPT_TOKENS,
    });

    const { results, raw } = await runModerationAnalysis({ targets: batch, contextText });
    for (const result of results) {
      const row = await updateMessageAIAnalysis(result.messageId, {
        status: result.status,
        flags: JSON.stringify(result.flags),
        score: result.score,
        raw: JSON.stringify({ model: config.AI_LLM_MODEL, response: raw }).slice(0, 20_000),
        analysis: result.analysis,
        analyzedAt: Date.now(),
        error: null,
      });
      if (row) (globalThis as any).moderationBroadcaster?.messageAnalyzed(row);
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logger.warn({ conversationKey, error }, "AI conversation analysis failed");
    const pending = await getPendingMessagesByConversation(conversationKey, MAX_BATCH_MESSAGES);
    for (const message of pending) {
      const row = await updateMessageAIAnalysis(message.id, {
        status: "error",
        flags: null,
        score: null,
        raw: null,
        analysis: null,
        analyzedAt: Date.now(),
        error: lastError,
      });
      if (row) (globalThis as any).moderationBroadcaster?.messageAnalyzed(row);
    }
  } finally {
    activeRequests--;
  }
}

async function drainQueue(): Promise<void> {
  const keys = Array.from(queuedConversations);
  queuedConversations.clear();
  for (const key of keys) await analyzeConversation(key);
}

export function queueConversationAnalysis(conversationKey: string): void {
  if (!config.AI_ANALYSIS_ENABLED) return;
  queuedConversations.add(conversationKey);
  const existing = debounceTimers.get(conversationKey);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    conversationKey,
    setTimeout(() => {
      debounceTimers.delete(conversationKey);
      drainQueue().catch((error) => logger.error({ error }, "AI queue failed"));
    }, DEBOUNCE_MS),
  );
}

export function queueMessageAnalysis(messageId: string): void {
  if (!config.AI_ANALYSIS_ENABLED) return;
  getMessageById(messageId)
    .then((message) => {
      if (message) queueConversationAnalysis(getConversationKey(message));
    })
    .catch((error) => logger.error({ messageId, error }, "Failed to queue message analysis"));
}

export function getAnalysisQueueStatus() {
  return { queuedConversations: queuedConversations.size, activeRequests, lastError };
}

export function startPendingAIAnalysisWorker(): void {
  if (!config.AI_ANALYSIS_ENABLED) {
    logger.info("AI analysis disabled");
    return;
  }

  logger.info("AI analysis worker started");
  setInterval(async () => {
    const keys = await getPendingConversationKeys(500);
    for (const key of keys) queueConversationAnalysis(key);
  }, 15000);
}
```

- [ ] **Step 5: Run queue tests**

Run: `pnpm vitest run tests/moderation/analysisQueue.test.ts`

Expected: PASS.

- [ ] **Step 6: Run related tests and typecheck**

Run: `pnpm vitest run tests/moderation && pnpm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/moderation/aiAnalyzer.ts src/moderation/messageStore.ts tests/moderation/analysisQueue.test.ts
git commit -m "feat: debounce ai analysis by conversation"
```

---

## Task 6: Focused route modules

**Files:**
- Create: `src/routes/messageRoutes.ts`
- Create: `src/routes/analysisRoutes.ts`
- Create: `src/routes/syncRoutes.ts`
- Create: `src/routes/uiStateRoutes.ts`
- Create: `src/routes/voiceRoutes.ts`
- Modify: `src/webserver.ts`
- Test: existing typecheck/smoke

- [ ] **Step 1: Create message routes**

Create `src/routes/messageRoutes.ts`:

```ts
import { Router } from "express";
import { AppError } from "../errors";
import {
  getAttachmentsByChannel,
  getMessageById,
  listMessages,
  listReviewMessages,
} from "../moderation/messageStore";
import type { AIStatus } from "../moderation/types";

function limitOf(value: unknown): number {
  return Math.max(1, Math.min(Number(value) || 50, 100));
}

function statusesOf(value: unknown): AIStatus[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split(",").filter((item): item is AIStatus =>
    ["pending", "clean", "warn", "flagged", "error"].includes(item),
  );
}

export function createMessageRoutes() {
  const router = Router();

  router.get("/messages", async (req, res, next) => {
    try {
      res.json(
        await listMessages({
          guildId: req.query.guildId as string | undefined,
          channelId: req.query.channelId as string | undefined,
          threadId: req.query.threadId as string | undefined,
          cursor: req.query.cursor as string | undefined,
          limit: limitOf(req.query.limit),
          status: statusesOf(req.query.status),
          userId: req.query.userId as string | undefined,
          q: req.query.q as string | undefined,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/messages/:id", async (req, res, next) => {
    try {
      const message = await getMessageById(req.params.id);
      if (!message) throw new AppError("Message not found", "MESSAGE_NOT_FOUND", 404);
      res.json(message);
    } catch (error) {
      next(error);
    }
  });

  router.get("/review", async (req, res, next) => {
    try {
      res.json(
        await listReviewMessages({
          guildId: req.query.guildId as string | undefined,
          channelId: req.query.channelId as string | undefined,
          cursor: req.query.cursor as string | undefined,
          limit: limitOf(req.query.limit),
          status: statusesOf(req.query.status),
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/attachments", async (req, res, next) => {
    try {
      const channelId = req.query.channelId as string | undefined;
      if (!channelId) throw new AppError("channelId is required", "MISSING_CHANNEL_ID", 400);
      const data = await getAttachmentsByChannel(channelId, limitOf(req.query.limit), 0);
      res.json({ data, nextCursor: null });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

- [ ] **Step 2: Create analysis routes**

Create `src/routes/analysisRoutes.ts`:

```ts
import { Router } from "express";
import { getAnalysisQueueStatus, queueMessageAnalysis } from "../moderation/aiAnalyzer";
import { updateMessageAIAnalysis } from "../moderation/messageStore";

export function createAnalysisRoutes() {
  const router = Router();

  router.get("/analysis/status", (_req, res) => {
    res.json(getAnalysisQueueStatus());
  });

  router.post("/messages/:id/reanalyze", async (req, res, next) => {
    try {
      const row = await updateMessageAIAnalysis(req.params.id, {
        status: "pending",
        flags: null,
        score: null,
        raw: null,
        analysis: null,
        analyzedAt: null,
        error: null,
      });
      queueMessageAnalysis(req.params.id);
      res.status(202).json(row);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

- [ ] **Step 3: Create sync routes**

Create `src/routes/syncRoutes.ts`:

```ts
import type { Client } from "discord.js-selfbot-v13";
import { Router } from "express";
import { AppError } from "../errors";
import { syncSelectedChannelBacklog } from "../moderation/backlogSync";

export function createSyncRoutes(client: Client) {
  const router = Router();

  router.post("/backlog-sync", async (req, res, next) => {
    try {
      const { guildId, channelId } = req.body as { guildId?: string; channelId?: string };
      if (!guildId || !channelId) {
        throw new AppError("guildId and channelId are required", "MISSING_BACKLOG_PARAMS", 400);
      }
      const count = await syncSelectedChannelBacklog(client, guildId, channelId);
      res.json({ success: true, channelId, messagesSync: count });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

- [ ] **Step 4: Create UI and voice route modules**

Move existing `/api/ui-state`, `/api/guilds`, `/api/connect`, `/api/disconnect`, `/api/status` route bodies from `src/webserver.ts` into `src/routes/uiStateRoutes.ts` and `src/routes/voiceRoutes.ts`. Keep function signatures:

```ts
export function createUIStateRoutes(input: {
  getSharedUIState: () => unknown;
  patchSharedUIState: (patch: Record<string, unknown>) => unknown;
})
```

```ts
export function createVoiceRoutes(voiceController: VoiceController)
```

- [ ] **Step 5: Register routes in webserver**

In `src/webserver.ts`, import route factories and replace inline `/api/*` definitions with:

```ts
app.use("/api", createUIStateRoutes({ getSharedUIState, patchSharedUIState }));
app.use("/api", createVoiceRoutes(voiceController));
app.use("/api", createMessageRoutes());
app.use("/api", createAnalysisRoutes());
app.use("/api", createSyncRoutes(_client));
```

Also instantiate broadcaster:

```ts
const broadcaster = createBroadcaster();
(globalThis as any).moderationBroadcaster = broadcaster;
```

Use broadcaster in WS connection add/remove and replace message broadcast globals where possible.

- [ ] **Step 6: Run typecheck**

Run: `pnpm run typecheck`

Expected: PASS.

- [ ] **Step 7: Run smoke tests**

Run: `pnpm vitest run tests/smoke.test.ts tests/config.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/routes src/webserver.ts
git commit -m "refactor: split api routes by concern"
```

---

## Task 7: Capture path cleanup

**Files:**
- Modify: `src/moderation/messageCapture.ts`
- Modify: `src/moderation/messageStore.ts`
- Test: existing moderation tests

- [ ] **Step 1: Add upsert/reset store helpers**

In `src/moderation/messageStore.ts`, add:

```ts
export async function upsertMessageForCapture(message: MessageRecord): Promise<void> {
  const db = getDatabase() as any;
  await db
    .insert(messagesTable)
    .values({ ...message, ai_status: "pending" })
    .onConflictDoUpdate({
      target: messagesTable.id,
      set: {
        content: message.content,
        edited_content: message.edited_content,
        metadata: message.metadata,
        ai_status: "pending",
        ai_error: null,
      },
    });
}
```

If `onConflictDoUpdate` target typing differs between Postgres/SQLite union tables, keep `insertMessage` and follow with `updateMessageAIAnalysis(id, { status: "pending", ... })` for the existing row path.

- [ ] **Step 2: Narrow capture responsibilities**

In `src/moderation/messageCapture.ts`:

- Replace direct `getDatabase` and `messagesTable` query with `getMessageById`.
- Replace `globalThis.broadcastMessageCreated` with `(globalThis as any).moderationBroadcaster?.messageCreated(messageRecord)`.
- Replace `globalThis.broadcastMessageUpdated` with typed broadcaster call.
- Replace `globalThis.broadcastMessageDeleted` with typed broadcaster call.
- Queue analysis after insert/edit only.

- [ ] **Step 3: Run moderation tests**

Run: `pnpm vitest run tests/moderation && pnpm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/moderation/messageCapture.ts src/moderation/messageStore.ts
git commit -m "refactor: keep message capture on fast path"
```

---

## Task 8: Database indexes and optional analysis run table

**Files:**
- Modify: `src/database/schema.ts`
- Create migration via Drizzle: `drizzle/migrations/*.sql`
- Test: `tests/database.test.ts`

- [ ] **Step 1: Add schema indexes**

In both PostgreSQL and SQLite message table definitions, add indexes matching these names if not already present:

```ts
channelCreatedIdx: pgIndex("idx_messages_channel_created").on(table.channel_id, table.created_at, table.id),
threadCreatedIdx: pgIndex("idx_messages_thread_created").on(table.thread_id, table.created_at, table.id),
aiStatusCreatedIdx: pgIndex("idx_messages_ai_status_created").on(table.ai_status, table.created_at, table.id),
guildAiStatusCreatedIdx: pgIndex("idx_messages_guild_ai_status_created").on(table.guild_id, table.ai_status, table.created_at, table.id),
```

Use `sqliteIndex` equivalents for SQLite.

For attachments, add:

```ts
channelCreatedIdx: pgIndex("idx_attachments_channel_created").on(table.channel_id, table.created_at, table.id),
threadCreatedIdx: pgIndex("idx_attachments_thread_created").on(table.thread_id, table.created_at, table.id),
```

Use `sqliteIndex` equivalents for SQLite.

- [ ] **Step 2: Add `ai_analysis_runs` schema**

Add PostgreSQL and SQLite table definitions with fields from spec, then export runtime-selected `aiAnalysisRunsTable`.

- [ ] **Step 3: Generate migration**

Run: `pnpm drizzle-kit generate`

Expected: new migration file under `drizzle/migrations/`.

- [ ] **Step 4: Run database tests**

Run: `pnpm vitest run tests/database.test.ts && pnpm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/database/schema.ts drizzle/migrations drizzle/migrations/meta tests/database.test.ts
git commit -m "feat: add moderation query indexes"
```

---

## Task 9: React/Vite app scaffold

**Files:**
- Modify: `package.json`
- Modify or create: `tsconfig.json` / `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/styles.css`

- [ ] **Step 1: Install frontend dependencies**

Run:

```bash
pnpm add react react-dom @vitejs/plugin-react vite
pnpm add -D @types/react @types/react-dom
```

Expected: dependencies added to `package.json` and lockfile updated.

- [ ] **Step 2: Add scripts**

Modify root `package.json` scripts:

```json
{
  "dev:server": "tsx watch src/index.ts",
  "dev:web": "vite --host 0.0.0.0 frontend",
  "build:web": "vite build frontend --outDir ../public/app --emptyOutDir",
  "build": "pnpm run build:web && tsc --outDir dist"
}
```

Keep existing `dev` and `start` unless replacing them is intentional.

- [ ] **Step 3: Create frontend HTML**

Create `frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Discord Moderation Watcher</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create React entry**

Create `frontend/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Create `frontend/src/App.tsx`:

```tsx
export function App() {
  return (
    <main className="shell">
      <aside className="sidebar">Discord Moderation Watcher</aside>
      <section className="content">Message feed loading...</section>
      <aside className="review">Needs Review</aside>
    </main>
  );
}
```

Create `frontend/src/styles.css`:

```css
:root {
  color-scheme: dark;
  font-family: Inter, system-ui, sans-serif;
  background: #0b1020;
  color: #edf2ff;
}

body {
  margin: 0;
}

.shell {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) 360px;
  min-height: 100vh;
}

.sidebar,
.content,
.review {
  padding: 20px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 5: Build frontend**

Run: `pnpm run build:web`

Expected: Vite build succeeds and writes `public/app`.

- [ ] **Step 6: Commit**

Run:

```bash
git add package.json pnpm-lock.yaml frontend public/app
git commit -m "feat: scaffold react dashboard"
```

---

## Task 10: Frontend API and WebSocket clients

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/ws/client.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create API client**

Create `frontend/src/api/client.ts`:

```ts
export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}

export interface DashboardMessage {
  id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  username: string;
  avatar_url: string | null;
  content: string;
  edited_content: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  ai_status?: "pending" | "clean" | "warn" | "flagged" | "error" | null;
  ai_moderation_flags?: string | null;
  ai_moderation_score?: number | null;
  ai_analysis?: string | null;
  ai_error?: string | null;
  metadata: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || response.statusText);
  }
  return response.json() as Promise<T>;
}

export function listMessages(params: URLSearchParams) {
  return request<PageResult<DashboardMessage>>(`/api/messages?${params}`);
}

export function listReview(params: URLSearchParams) {
  return request<PageResult<DashboardMessage>>(`/api/review?${params}`);
}

export function reanalyzeMessage(id: string) {
  return request<DashboardMessage>(`/api/messages/${id}/reanalyze`, { method: "POST" });
}

export function getGuilds() {
  return request<Array<{ id: string; name: string }>>("/api/guilds");
}
```

- [ ] **Step 2: Create WS client**

Create `frontend/src/ws/client.ts`:

```ts
import type { DashboardMessage } from "../api/client";

export type DashboardEvent =
  | { type: "message_created"; data: DashboardMessage }
  | { type: "message_updated"; data: Partial<DashboardMessage> & { id: string } }
  | { type: "message_deleted"; data: { id: string; deleted_at: number } }
  | { type: "message_analyzed"; data: DashboardMessage }
  | { type: "analysis_queue_status"; data: unknown }
  | { type: "ui_state"; state: unknown }
  | { type: "user_state"; users: unknown[] };

export function connectDashboardSocket(onEvent: (event: DashboardEvent) => void) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    onEvent(JSON.parse(event.data) as DashboardEvent);
  };
  return socket;
}
```

- [ ] **Step 3: Smoke use in App**

Update `frontend/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { listMessages, type DashboardMessage } from "./api/client";
import { connectDashboardSocket } from "./ws/client";

export function App() {
  const [messages, setMessages] = useState<DashboardMessage[]>([]);

  useEffect(() => {
    listMessages(new URLSearchParams({ limit: "30" }))
      .then((page) => setMessages(page.data))
      .catch(() => setMessages([]));

    const socket = connectDashboardSocket((event) => {
      if (event.type === "message_created") setMessages((items) => [event.data, ...items]);
      if (event.type === "message_analyzed") {
        setMessages((items) => items.map((item) => (item.id === event.data.id ? event.data : item)));
      }
    });
    return () => socket.close();
  }, []);

  return (
    <main className="shell">
      <aside className="sidebar">Discord Moderation Watcher</aside>
      <section className="content">
        {messages.map((message) => (
          <article key={message.id}>{message.username}: {message.edited_content || message.content}</article>
        ))}
      </section>
      <aside className="review">Needs Review</aside>
    </main>
  );
}
```

- [ ] **Step 4: Build frontend**

Run: `pnpm run build:web`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src
git commit -m "feat: add dashboard api clients"
```

---

## Task 11: Dashboard components and review flow

**Files:**
- Create component/state files listed in File Structure
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Create message card**

Create `frontend/src/components/messages/MessageCard.tsx`:

```tsx
import type { DashboardMessage } from "../../api/client";

export function MessageCard({ message, onReanalyze }: { message: DashboardMessage; onReanalyze: (id: string) => void }) {
  const status = message.ai_status || "pending";
  return (
    <article className={`message-card status-${status}`}>
      <header>
        <strong>{message.username || message.user_id}</strong>
        <time>{new Date(message.created_at).toLocaleString()}</time>
      </header>
      <p>{message.edited_content || message.content || "(empty message)"}</p>
      <div className="badges">
        <span>{status}</span>
        {message.edited_at ? <span>edited</span> : null}
        {message.deleted_at ? <span>deleted</span> : null}
      </div>
      {message.ai_analysis ? <p className="analysis">{message.ai_analysis}</p> : null}
      {message.ai_error ? <p className="analysis error">AI error: {message.ai_error}</p> : null}
      <button type="button" onClick={() => onReanalyze(message.id)}>Reanalyze</button>
    </article>
  );
}
```

- [ ] **Step 2: Create feed and review panel**

Create `frontend/src/components/messages/MessageFeed.tsx` and `frontend/src/components/review/ReviewPanel.tsx` using `MessageCard`. `ReviewPanel` filters messages where `ai_status` is `warn`, `flagged`, or `error`.

- [ ] **Step 3: Add styles**

Append to `frontend/src/styles.css`:

```css
.message-card {
  display: grid;
  gap: 10px;
  padding: 14px;
  margin-bottom: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.04);
}

.message-card header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #c9d7ff;
}

.badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.badges span {
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.status-warn {
  border-color: rgba(255, 196, 87, 0.55);
}

.status-flagged,
.status-error {
  border-color: rgba(255, 92, 122, 0.65);
}

.analysis {
  color: #b7c6ff;
}

.error {
  color: #ff8ca3;
}
```

- [ ] **Step 4: Wire App with reanalysis**

Update `frontend/src/App.tsx` to call `reanalyzeMessage` and update the item to pending on success.

- [ ] **Step 5: Build frontend**

Run: `pnpm run build:web`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src
git commit -m "feat: add moderation review dashboard"
```

---

## Task 12: Final verification and cleanup

**Files:**
- Modify: `public/index.html` or Express static route if needed
- Remove: obsolete static dashboard code only after React app is served correctly
- Run all tests/builds

- [ ] **Step 1: Point root to React app**

Update `src/webserver.ts` static serving so production root serves `public/app/index.html` when it exists. Keep fallback to old `public/index.html` during transition.

- [ ] **Step 2: Run full backend verification**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
```

Expected: all PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
pnpm run build:web
```

Expected: PASS.

- [ ] **Step 4: Manual browser verification**

Run server:

```bash
pnpm run dev
```

Open dashboard and verify:

- Guild/channel selectors load.
- Message feed loads with cursor pagination.
- Review panel shows warn/flagged/error.
- WebSocket updates patch message status.
- Reanalyze button marks message pending and queues AI.
- Voice connect/listen/transmit controls still work.

- [ ] **Step 5: Cleanup obsolete static FE**

After browser verification, remove or stop linking old static inline dashboard code. Keep `dashboard.css` only if React still imports or copies needed styles; otherwise delete it.

- [ ] **Step 6: Final commit**

Run:

```bash
git add src public frontend package.json pnpm-lock.yaml tests drizzle
git commit -m "feat: rebuild moderation dashboard flow"
```

---

## Self-Review

- Spec coverage: backend boundaries, async AI queue, conversation context, split APIs, typed WS, DB indexes, React/Vite frontend, performance rules, and tests are all mapped to tasks.
- Placeholder scan: no `TBD` or vague implementation-only steps remain; tasks include paths, commands, expected results, and starter code.
- Type consistency: shared `AIStatus`, `MessageRecord`, `AnalysisResult`, `PageResult`, and event names are consistent across tasks.
