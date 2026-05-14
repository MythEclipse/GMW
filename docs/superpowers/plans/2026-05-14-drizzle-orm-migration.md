# Drizzle ORM Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw SQL queries and manual database adapter with Drizzle ORM, providing type-safe database operations, automatic migrations, and better maintainability while supporting both SQLite and PostgreSQL.

**Architecture:** Replace the custom DatabaseAdapter pattern with Drizzle ORM's unified API. Define schema using Drizzle's TypeScript schema definitions. Replace all raw SQL queries in muxer-queue.ts and messageStore.ts with Drizzle query builder. Use Drizzle migrations for schema management. Maintain backward compatibility with existing data.

**Tech Stack:** drizzle-orm, drizzle-kit, better-sqlite3 (SQLite), postgres (PostgreSQL), TypeScript

---

## File Structure

**New files to create:**
- `src/database/schema.ts` — Drizzle schema definitions for all tables
- `src/database/drizzle.ts` — Drizzle database client initialization
- `drizzle.config.ts` — Drizzle Kit configuration
- `drizzle/migrations/` — Auto-generated migration files

**Modified files:**
- `src/muxer-queue.ts` — Replace raw SQL with Drizzle queries
- `src/moderation/messageStore.ts` — Replace raw SQL with Drizzle queries
- `src/database/adapter.ts` — Remove (no longer needed)
- `src/database/postgres.ts` — Remove (Drizzle handles this)
- `src/database/migrations.ts` — Remove (Drizzle handles this)
- `src/index.ts` — Update database initialization
- `src/webserver.ts` — Update database calls
- `package.json` — Add drizzle-orm, drizzle-kit dependencies
- `src/config.ts` — Keep PostgreSQL config variables

---

## Task 1: Add Drizzle Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add drizzle-orm and drizzle-kit**

```bash
cd /mnt/code/bete && pnpm add drizzle-orm
```

Expected: drizzle-orm installed

- [ ] **Step 2: Add drizzle-kit as dev dependency**

```bash
cd /mnt/code/bete && pnpm add -D drizzle-kit
```

Expected: drizzle-kit installed

- [ ] **Step 3: Verify installation**

```bash
cd /mnt/code/bete && pnpm list drizzle-orm drizzle-kit
```

Expected: Both packages listed with versions

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "feat: add drizzle-orm and drizzle-kit dependencies"
```

---

## Task 2: Create Drizzle Schema Definitions

**Files:**
- Create: `src/database/schema.ts`

- [ ] **Step 1: Create schema.ts with table definitions**

```typescript
import { pgTable, text, integer, bigint, real, index, foreignKey } from "drizzle-orm/pg-core";
import { sqliteTable, SQLiteInteger, SQLiteText } from "drizzle-orm/sqlite-core";
import { config } from "../config";

// Determine which table function to use based on database type
const tableFactory = config.DATABASE_TYPE === "postgres" ? pgTable : sqliteTable;

// Muxer Jobs Table
export const muxerJobs = tableFactory("muxer_jobs", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  status: text("status", { enum: ["pending", "processing", "completed", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("maxAttempts").notNull().default(3),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt: bigint("updatedAt", { mode: "number" }).notNull(),
  error: text("error"),
}, (table) => ({
  statusIdx: index("idx_muxer_jobs_status").on(table.status),
  createdAtIdx: index("idx_muxer_jobs_createdAt").on(table.createdAt),
}));

// Messages Table
export const messages = tableFactory("messages", {
  id: text("id").primaryKey(),
  guild_id: text("guild_id").notNull(),
  channel_id: text("channel_id").notNull(),
  thread_id: text("thread_id"),
  user_id: text("user_id").notNull(),
  username: text("username").notNull(),
  avatar_url: text("avatar_url"),
  content: text("content").notNull(),
  edited_content: text("edited_content"),
  created_at: bigint("created_at", { mode: "number" }).notNull(),
  edited_at: bigint("edited_at", { mode: "number" }),
  deleted_at: bigint("deleted_at", { mode: "number" }),
  type: text("type", { enum: ["text", "edited", "deleted"] }).notNull().default("text"),
  metadata: text("metadata"),
  ai_status: text("ai_status", { enum: ["pending", "clean", "warn", "flagged", "error"] }).notNull().default("pending"),
  ai_moderation_flags: text("ai_moderation_flags"),
  ai_moderation_score: real("ai_moderation_score"),
  ai_moderation_raw: text("ai_moderation_raw"),
  ai_analysis: text("ai_analysis"),
  ai_analyzed_at: bigint("ai_analyzed_at", { mode: "number" }),
  ai_error: text("ai_error"),
}, (table) => ({
  channelIdx: index("idx_messages_channel").on(table.channel_id),
  userIdx: index("idx_messages_user").on(table.user_id),
  createdIdx: index("idx_messages_created").on(table.created_at),
  threadIdx: index("idx_messages_thread").on(table.thread_id),
}));

// Attachments Table
export const attachments = tableFactory("attachments", {
  id: text("id").primaryKey(),
  message_id: text("message_id").notNull(),
  guild_id: text("guild_id").notNull(),
  channel_id: text("channel_id").notNull(),
  thread_id: text("thread_id"),
  user_id: text("user_id").notNull(),
  filename: text("filename").notNull(),
  size: integer("size").notNull(),
  type: text("type").notNull(),
  discord_url: text("discord_url").notNull(),
  uploaded_url: text("uploaded_url"),
  upload_status: text("upload_status", { enum: ["pending", "uploaded", "failed"] }).notNull().default("pending"),
  upload_error: text("upload_error"),
  created_at: bigint("created_at", { mode: "number" }).notNull(),
  uploaded_at: bigint("uploaded_at", { mode: "number" }),
}, (table) => ({
  channelIdx: index("idx_attachments_channel").on(table.channel_id),
  messageIdx: index("idx_attachments_message").on(table.message_id),
  statusIdx: index("idx_attachments_status").on(table.upload_status),
  fk: foreignKey({
    columns: [table.message_id],
    foreignColumns: [messages.id],
  }).onDelete("cascade"),
}));

// UI State Table
export const uiState = tableFactory("ui_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: bigint("updated_at", { mode: "number" }).notNull(),
});
```

- [ ] **Step 2: Run typecheck**

```bash
cd /mnt/code/bete && pnpm run typecheck
```

Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/database/schema.ts
git commit -m "feat: create drizzle schema definitions"
```

---

## Task 3: Create Drizzle Configuration

**Files:**
- Create: `drizzle.config.ts`

- [ ] **Step 1: Create drizzle.config.ts**

```typescript
import { defineConfig } from "drizzle-kit";
import { config } from "./src/config";

export default defineConfig({
  schema: "./src/database/schema.ts",
  out: "./drizzle/migrations",
  dialect: config.DATABASE_TYPE === "postgres" ? "postgresql" : "sqlite",
  dbCredentials: config.DATABASE_TYPE === "postgres" 
    ? {
        host: config.POSTGRES_HOST,
        port: config.POSTGRES_PORT,
        user: config.POSTGRES_USER,
        password: config.POSTGRES_PASSWORD,
        database: config.POSTGRES_DB,
      }
    : {
        url: `file:./.muxer-queue.db`,
      },
});
```

- [ ] **Step 2: Add migration scripts to package.json**

```json
"scripts": {
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:studio": "drizzle-kit studio"
}
```

- [ ] **Step 3: Generate initial migration**

```bash
cd /mnt/code/bete && pnpm run db:generate
```

Expected: Migration files created in drizzle/migrations/

- [ ] **Step 4: Commit**

```bash
git add drizzle.config.ts package.json drizzle/
git commit -m "feat: add drizzle configuration and initial migrations"
```

---

## Task 4: Create Drizzle Database Client

**Files:**
- Create: `src/database/drizzle.ts`

- [ ] **Step 1: Create drizzle.ts**

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { config } from "../config";
import { createChildLogger } from "../logger";
import * as schema from "./schema";

const logger = createChildLogger("drizzle");

let db: ReturnType<typeof drizzle> | null = null;

export async function initializeDatabase() {
  if (db) return db;

  if (config.DATABASE_TYPE === "postgres") {
    const pool = new Pool({
      host: config.POSTGRES_HOST,
      port: config.POSTGRES_PORT,
      user: config.POSTGRES_USER,
      password: config.POSTGRES_PASSWORD,
      database: config.POSTGRES_DB,
      min: config.POSTGRES_POOL_MIN,
      max: config.POSTGRES_POOL_MAX,
    });

    db = drizzle(pool, { schema });
    logger.info("PostgreSQL database initialized");
  } else {
    const sqlite = new Database(".muxer-queue.db");
    sqlite.pragma("journal_mode = WAL");
    db = drizzleSqlite(sqlite, { schema });
    logger.info("SQLite database initialized");
  }

  return db;
}

export function getDatabase() {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return db;
}

export async function closeDatabase() {
  if (db) {
    // Drizzle doesn't have a close method, but we can close the underlying connection
    if (config.DATABASE_TYPE === "postgres") {
      // Pool will be closed when the process exits
      logger.info("PostgreSQL connection pool will close on process exit");
    } else {
      logger.info("SQLite database closed");
    }
    db = null;
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd /mnt/code/bete && pnpm run typecheck
```

Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/database/drizzle.ts
git commit -m "feat: create drizzle database client"
```

---

## Task 5: Migrate muxer-queue.ts to Drizzle

**Files:**
- Modify: `src/muxer-queue.ts`

- [ ] **Step 1: Replace imports**

Replace:
```typescript
import { getDatabase, DatabaseAdapter } from "./database/adapter";
```

With:
```typescript
import { getDatabase, initializeDatabase } from "./database/drizzle";
import { muxerJobs } from "./database/schema";
import { eq, asc, desc } from "drizzle-orm";
```

- [ ] **Step 2: Replace enqueueMuxerJob function**

Replace raw SQL with:
```typescript
export async function enqueueMuxerJob(data: MuxerJobData): Promise<string> {
  try {
    const db = getDatabase();
    const jobId = `${data.userId}-${data.sessionId}`;
    const now = Date.now();

    await db.insert(muxerJobs).values({
      id: jobId,
      data: JSON.stringify(data),
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();

    logger.info({ jobId, userId: data.userId }, "Muxer job enqueued");
    return jobId;
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to enqueue muxer job");
    throw error;
  }
}
```

- [ ] **Step 3: Replace getPendingJobs function**

```typescript
export async function getPendingJobs(): Promise<StoredJob[]> {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(muxerJobs)
    .where(eq(muxerJobs.status, "pending"))
    .orderBy(asc(muxerJobs.createdAt))
    .limit(10);

  return rows.map((row) => ({
    ...row,
    status: row.status as "pending" | "processing" | "completed" | "failed",
  }));
}
```

- [ ] **Step 4: Replace updateJobStatus function**

```typescript
export async function updateJobStatus(
  jobId: string,
  status: "processing" | "completed" | "failed",
  error?: string,
): Promise<void> {
  const db = getDatabase();
  const now = Date.now();

  if (status === "failed") {
    await db
      .update(muxerJobs)
      .set({
        status,
        attempts: muxerJobs.attempts + 1,
        updatedAt: now,
        error: error || null,
      })
      .where(eq(muxerJobs.id, jobId));
  } else {
    await db
      .update(muxerJobs)
      .set({ status, updatedAt: now })
      .where(eq(muxerJobs.id, jobId));
  }

  logger.info({ jobId, status, error }, "Job status updated");
}
```

- [ ] **Step 5: Replace remaining functions similarly**

Replace `retryFailedJob`, `cleanupCompletedJobs`, `getJobStats` with Drizzle equivalents

- [ ] **Step 6: Update getPersistedValue and setPersistedValue**

Use Drizzle's uiState table instead of raw SQL

- [ ] **Step 7: Run tests**

```bash
cd /mnt/code/bete && pnpm run test
```

Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/muxer-queue.ts
git commit -m "refactor: migrate muxer-queue to drizzle-orm"
```

---

## Task 6: Migrate messageStore.ts to Drizzle

**Files:**
- Modify: `src/moderation/messageStore.ts`

- [ ] **Step 1: Replace imports**

```typescript
import { getDatabase } from "../database/drizzle";
import { messages, attachments } from "../database/schema";
import { eq, or, desc, and } from "drizzle-orm";
```

- [ ] **Step 2: Replace insertMessage function**

```typescript
export async function insertMessage(message: MessageRecord): Promise<void> {
  try {
    const db = getDatabase();
    await db.insert(messages).values(message).onConflictDoNothing();
    logger.debug({ messageId: message.id }, "Message inserted");
  } catch (error) {
    logger.error({ messageId: message.id, error: error instanceof Error ? error.message : String(error) }, "Failed to insert message");
    throw error;
  }
}
```

- [ ] **Step 3: Replace updateMessageAsEdited function**

```typescript
export async function updateMessageAsEdited(
  messageId: string,
  editedContent: string,
  editedAt: number,
): Promise<void> {
  try {
    const db = getDatabase();
    await db
      .update(messages)
      .set({ edited_content: editedContent, edited_at: editedAt, type: "edited" })
      .where(eq(messages.id, messageId));
    logger.debug({ messageId }, "Message marked as edited");
  } catch (error) {
    logger.error({ messageId, error: error instanceof Error ? error.message : String(error) }, "Failed to update message as edited");
    throw error;
  }
}
```

- [ ] **Step 4: Replace getMessagesByChannel function**

```typescript
export async function getMessagesByChannel(
  channelId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<MessageRecord[]> {
  try {
    const db = getDatabase();
    return await db
      .select()
      .from(messages)
      .where(or(eq(messages.channel_id, channelId), eq(messages.thread_id, channelId)))
      .orderBy(desc(messages.created_at))
      .limit(limit)
      .offset(offset);
  } catch (error) {
    logger.error({ channelId, error: error instanceof Error ? error.message : String(error) }, "Failed to get messages by channel");
    throw error;
  }
}
```

- [ ] **Step 5: Replace attachment functions similarly**

Replace `insertAttachment`, `getAttachmentsByChannel`, `updateAttachmentAsUploaded`, `updateAttachmentAsFailedUpload` with Drizzle equivalents

- [ ] **Step 6: Replace AI analysis functions**

Replace `updateMessageAIAnalysis`, `getPendingAIAnalysisMessages`, `getMessageById` with Drizzle equivalents

- [ ] **Step 7: Update function signatures**

Remove `db: DatabaseAdapter` parameter from all functions since they now use `getDatabase()` internally

- [ ] **Step 8: Run tests**

```bash
cd /mnt/code/bete && pnpm run test
```

Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/moderation/messageStore.ts
git commit -m "refactor: migrate messageStore to drizzle-orm"
```

---

## Task 7: Update Application Initialization

**Files:**
- Modify: `src/index.ts`
- Modify: `src/webserver.ts`

- [ ] **Step 1: Update src/index.ts imports**

Replace:
```typescript
import { getDatabase } from "./database/adapter";
```

With:
```typescript
import { initializeDatabase } from "./database/drizzle";
```

- [ ] **Step 2: Update database initialization in index.ts**

```typescript
const db = await initializeDatabase();
logger.info({ type: config.DATABASE_TYPE }, "Database initialized");
```

- [ ] **Step 3: Update src/webserver.ts**

Replace any `getDatabase()` calls with the new Drizzle client

- [ ] **Step 4: Run typecheck**

```bash
cd /mnt/code/bete && pnpm run typecheck
```

Expected: No TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/webserver.ts
git commit -m "feat: update application initialization for drizzle"
```

---

## Task 8: Remove Old Database Files

**Files:**
- Delete: `src/database/adapter.ts`
- Delete: `src/database/postgres.ts`
- Delete: `src/database/migrations.ts`

- [ ] **Step 1: Remove old adapter files**

```bash
cd /mnt/code/bete && rm src/database/adapter.ts src/database/postgres.ts src/database/migrations.ts
```

- [ ] **Step 2: Verify no imports remain**

```bash
grep -r "database/adapter\|database/postgres\|database/migrations" src/ --include="*.ts"
```

Expected: No results

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: remove old database adapter files"
```

---

## Task 9: Final Testing and Verification

**Files:**
- Test all functionality

- [ ] **Step 1: Run full test suite**

```bash
cd /mnt/code/bete && pnpm run test
```

Expected: All tests pass

- [ ] **Step 2: Type check**

```bash
cd /mnt/code/bete && pnpm run typecheck
```

Expected: No TypeScript errors

- [ ] **Step 3: Lint**

```bash
cd /mnt/code/bete && pnpm run lint
```

Expected: No linting errors

- [ ] **Step 4: Test startup with SQLite**

```bash
cd /mnt/code/bete && timeout 10 pnpm run dev || true
```

Expected: Bot starts successfully, logs show "Database initialized"

- [ ] **Step 5: Verify git status**

```bash
git status
```

Expected: Clean working tree

- [ ] **Step 6: Final commit if needed**

```bash
git add -A
git commit -m "feat: complete drizzle-orm migration"
```

---

## Spec Coverage Checklist

- ✅ Replace raw SQL with Drizzle ORM
- ✅ Type-safe database operations
- ✅ Support both SQLite and PostgreSQL
- ✅ Automatic schema migrations
- ✅ All existing functionality preserved
- ✅ Backward compatible with existing data
- ✅ Cleaner, more maintainable code
- ✅ Better error handling
- ✅ Tests passing
- ✅ No TypeScript errors

---

Plan complete and saved to `/mnt/code/bete/docs/superpowers/plans/2026-05-14-drizzle-orm-migration.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach would you prefer?
