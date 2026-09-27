/**
 * Auto-delete enforcement loop.
 *
 * The rewrite deleted the auto-delete modules (894 lines) but left the config,
 * the `msg.delete()` call and the `MANAGE_MESSAGES` check. Nothing decided to
 * call any of it, so the gateway has deleted nothing since. This module is the
 * missing decision.
 *
 * WHY A POLL AND NOT AN EVENT
 * The worker that produces verdicts runs as a separate process and holds only
 * a database pool — deliberately, so a slow or failing model can never stall
 * message capture. It does not publish to Redis, and adding that would couple
 * the two processes again. The gateway already polls elsewhere (retention,
 * digest scheduler), so a bounded poll over the verdicts table keeps the
 * dependency direction intact: the gateway reads the database, the worker
 * writes it, neither waits on the other.
 *
 * WHY A SENTINEL COLUMN AND NOT `created_at`
 * Re-reading recent rows by timestamp would let a message be deleted twice
 * after a restart, and would have to guess how far back to look. Instead a row
 * is only considered once, and that decision is recorded on the verdict itself
 * so it survives restarts and is visible in the dashboard.
 */
import type { Client } from "discord.js-selfbot-v13";
import { sql } from "drizzle-orm";
import { config } from "../../shared/config/index.js";
import { getDatabase } from "../../shared/database/drizzle.js";
import { createChildLogger } from "../../shared/logger/index.js";
import type { VerdictLike } from "./autoDeleteEligibility.js";
import {
  type AutoDeleteResult,
  attemptAutoDeleteFlaggedMessage,
} from "./autoDeleteManager.js";

const logger = createChildLogger("auto-delete-enforcer");

/** How often to look for newly judged messages. */
const POLL_INTERVAL_MS = 5_000;
/** Never touch more than this per tick, so a backlog cannot stall capture. */
const BATCH_LIMIT = 10;

// The marker columns live on `verdicts` but are not part of the Drizzle
// schema for that table (it is declared read-only, since the gateway only ever
// appends verdicts via the worker). They are added in 0022_enforce_verdicts.
// Referenced by raw SQL on purpose: see the comment above.
const MARKER_COLUMNS = "auto_delete_state, auto_delete_claimed_at";

interface Row {
  message_id: string;
  status: string;
  severity: string | null;
  confidence: number | null;
  score: number | null;
  recommended_action: string | null;
  categories: string[] | null;
  flags: string[] | null;
  analysis: string | null;
  auto_delete_state: string | null;
  guild_id: string;
  channel_id: string;
  user_id: string;
  thread_id: string | null;
  username: string | null;
  content: string | null;
  edited_content: string | null;
  metadata: unknown;
}

/** Verdicts awaiting a decision, oldest first. */
async function claimUnenforced(limit: number): Promise<Row[]> {
  const db = getDatabase();
  // Two things this has to get right:
  //
  // 1. The candidate set is a CTE, and `messages` is joined in the UPDATE's own
  //    FROM clause. The first version put the join only in a subquery and then
  //    tried to RETURN the message columns — Postgres rejects that outright
  //    ("missing FROM-clause entry for table m"), so the loop failed every tick
  //    even with the columns present. A column is only RETURNable if it appears
  //    in the UPDATE's own FROM.
  //
  // 2. `FOR UPDATE OF v SKIP LOCKED` locks only the verdict rows, so two
  //    gateway processes can never both act on the same message and neither
  //    blocks waiting on the other.
  const res = await db.execute(sql`
    WITH candidates AS (
      SELECT v.message_id
      FROM verdicts v
      JOIN messages m ON m.id = v.message_id
      WHERE v.status IN ('flagged', 'warn')
        AND m.deleted_at IS NULL
        AND (v.${sql.raw("auto_delete_state")} IS NULL
             OR v.${sql.raw("auto_delete_state")} = 'pending')
      ORDER BY v.created_at ASC
      LIMIT ${limit}
      FOR UPDATE OF v SKIP LOCKED
    )
    UPDATE verdicts v
    SET ${sql.raw("auto_delete_state")} = 'claimed',
        ${sql.raw("auto_delete_claimed_at")} = ${Date.now()}
    FROM messages m
    WHERE v.message_id IN (SELECT message_id FROM candidates)
      AND m.id = v.message_id
    RETURNING v.message_id, v.status, v.severity, v.confidence, v.score,
              v.recommended_action, v.categories, v.flags, v.analysis,
              m.guild_id, m.channel_id, m.user_id, m.thread_id, m.username,
              m.content, m.edited_content, m.metadata
  `);
  return Array.isArray(res)
    ? (res as unknown as Row[])
    : ((res as unknown as { rows: Row[] }).rows ?? []);
}

async function markState(messageId: string, state: string): Promise<void> {
  const db = getDatabase();
  await db.execute(sql`
    UPDATE verdicts
    SET ${sql.raw("auto_delete_state")} = ${state},
        ${sql.raw("auto_delete_claimed_at")} = ${Date.now()}
    WHERE message_id = ${messageId}
  `);
}

/**
 * Re-queue rows stuck in `claimed` (gateway died mid-batch) so they are retried.
 */
async function releaseStaleClaims(): Promise<number> {
  const cutoff = Date.now() - 60_000;
  const db = getDatabase();
  const res = await db.execute(sql`
    UPDATE verdicts
    SET ${sql.raw("auto_delete_state")} = 'pending'
    WHERE ${sql.raw("auto_delete_state")} = 'claimed'
      AND ${sql.raw("auto_delete_claimed_at")} < ${cutoff}
  `);
  const rows = Array.isArray(res) ? res : [];
  return rows.length ?? 0;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(client: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    const released = await releaseStaleClaims();
    if (released > 0) {
      logger.warn(
        { released },
        "Re-queued auto-delete claims left by a dead gateway",
      );
    }

    const rows = await claimUnenforced(BATCH_LIMIT);
    if (rows.length === 0) return;

    for (const row of rows) {
      const verdict: VerdictLike = {
        status: row.status,
        severity: row.severity,
        confidence: row.confidence,
        score: row.score,
        recommended_action: row.recommended_action,
        categories: row.categories ?? [],
        flags: row.flags ?? [],
        analysis: row.analysis,
      };

      let result: AutoDeleteResult;
      try {
        result = await attemptAutoDeleteFlaggedMessage(
          client,
          {
            id: row.message_id,
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            user_id: row.user_id,
            thread_id: row.thread_id,
            username: row.username,
            content: row.content,
            edited_content: row.edited_content,
            metadata: row.metadata,
          },
          verdict,
        );
      } catch (error) {
        // attemptAutoDeleteFlaggedMessage is contracted not to throw. If it
        // ever does, record the failure and move on — one bad message must not
        // stop the loop.
        logger.error(
          {
            messageId: row.message_id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Auto-delete threw unexpectedly",
        );
        await markState(row.message_id, "failed");
        continue;
      }

      // `skipped` with a non-permanent reason means the message is not
      // eligible right now (clean, or filtered). Recording it as decided stops
      // us re-reading it every 5 seconds forever; `pending` is only for
      // conditions that may change on their own, like a missing channel.
      const retryable =
        result.reason === "guild_not_found" ||
        result.reason === "channel_not_found" ||
        result.reason === "unsupported_channel";
      await markState(
        row.message_id,
        result.deleted || !retryable ? "done" : "pending",
      );

      logger.info(
        {
          messageId: row.message_id,
          reason: result.reason,
          deleted: result.deleted,
        },
        "Auto-delete decision applied",
      );
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Auto-delete tick failed",
    );
  } finally {
    running = false;
  }
}

/**
 * Start the enforcement loop. Idempotent.
 */
export function startAutoDeleteEnforcer(client: Client): void {
  if (!config.AUTO_DELETE_FLAGGED_ENABLED) {
    logger.info(
      "Auto-delete disabled by config — enforcement loop not started",
    );
    return;
  }
  if (timer) return;

  logger.info(
    {
      intervalMs: POLL_INTERVAL_MS,
      batch: BATCH_LIMIT,
      dryRun: config.AUTO_DELETE_FLAGGED_DRY_RUN,
    },
    "Starting auto-delete enforcement loop",
  );
  timer = setInterval(() => {
    void tick(client);
  }, POLL_INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();
}

export function stopAutoDeleteEnforcer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export { MARKER_COLUMNS };
