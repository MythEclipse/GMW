/**
 * Publish newly-written verdicts to the dashboard.
 *
 * ## Why this exists
 *
 * The worker is deliberately a database-only process: it holds a pg Pool and
 * nothing else, so a slow or failing model can never stall message capture.
 * The cost of that isolation is that it publishes nothing. It writes the
 * `verdicts` row, sets `messages.ai_status = 'analyzed'`, and exits — no Redis,
 * no event, no notification.
 *
 * `EventBroadcaster.messageAnalyzed()` and the backend's Redis bridge both
 * exist and are correct. Nothing ever CALLS them. The frontend's
 * `message_analyzed` handler (hooks/use-messages.ts) has therefore never
 * fired in production, and the live message stream was frozen at whatever the
 * server render happened to fetch: a message captured a second ago showed
 * `ai_status: 'pending'` with no verdict, which the badge renders as
 * "unjudged", and nothing ever corrected it without a manual reload.
 *
 * Verified against the running stack: a headless browser attached to
 * /messages/ received 0 WebSocket frames while the worker was actively
 * writing verdicts, and the badges on screen were 49x "clean" + 1x
 * "flagged" — all of them from the SSR payload, none from a live update.
 *
 * ## Why the gateway publishes it
 *
 * The gateway already holds a Redis connection and already polls the
 * `verdicts` table (autoDeleteEnforcer does, for enforcement). Reusing that
 * poll keeps the dependency direction intact: the worker writes the
 * database, the gateway reads it and tells the dashboard, and neither waits
 * on the other. Giving the worker a Redis client to close the loop would
 * re-couple the two processes that the split exists to separate.
 *
 * ## What is published
 *
 * Only the `message_analyzed` event the frontend already handles, carrying
 * the fields the badge needs. Deliberately NOT a full message record: the
 * frontend replaces the row wholesale on this event, so a partial payload
 * would blank out username/content/channel.
 */

import { sql } from "drizzle-orm";
import { config } from "../../shared/config/index.js";
import { getDatabase } from "../../shared/database/drizzle.js";
import { createChildLogger } from "../../shared/logger/index.js";
import type { EventBroadcaster } from "../event-broadcaster/eventBroadcaster.js";
import type { MessageRecord } from "../message-capture/types.js";

const logger = createChildLogger("verdict-notifier");

/** How often to look for verdicts the dashboard has not been told about. */
const POLL_INTERVAL_MS = 3_000;
/** Never publish more than this per tick, so a backlog cannot stall capture. */
const BATCH_LIMIT = 50;

interface VerdictRow {
  message_id: string;
  status: string;
  severity: string | null;
  score: number | null;
  confidence: number | null;
  recommended_action: string | null;
  flags: string[] | null;
  categories: string[] | null;
  analysis: string | null;
  duration_ms: number | null;
  model: string | null;
  policy_version: string | null;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  content: string | null;
  edited_content: string | null;
  metadata: string | null;
  created_at: string;
  /** Epoch millis of the last write to this verdict. The cursor. */
  updated_at: string;
}

/**
 * Verdicts written since the last tick, as a (updated_at, message_id) cursor.
 *
 * `updated_at` is the cursor, not `created_at`: a re-analysis updates an
 * existing row in place (ON CONFLICT DO UPDATE), and its `created_at` is the
 * original judgement's time, so a cursor on `created_at` would miss every
 * re-analysis.
 *
 * The comparison is STRICTLY greater and carries a message_id tiebreak. An
 * inclusive `>=` on `updated_at` alone re-selects the newest row on every
 * single tick — measured in production, one verdict was republished 4x in
 * 40 seconds — and message_id alone cannot order rows that share a
 * millisecond. The pair is a total order, so each verdict is published once.
 */
async function fetchUnnotified(
  sinceMs: number,
  sinceId: string,
): Promise<VerdictRow[]> {
  const db = getDatabase();
  // Raw SQL: `verdicts` is not in the Drizzle schema (the gateway treats it
  // as read-only), which is the same reason autoDeleteEnforcer queries it
  // this way. The values are bound parameters, never interpolated.
  const res = await db.execute(sql`
    SELECT v.message_id, v.status, v.severity, v.score, v.confidence,
           v.recommended_action, v.flags, v.categories, v.analysis,
           v.duration_ms, v.model, v.policy_version, v.updated_at,
           m.guild_id, m.channel_id, m.thread_id, m.user_id, m.username,
           m.avatar_url, m.content, m.edited_content, m.metadata,
           m.created_at
      FROM verdicts v
      JOIN messages m ON m.id = v.message_id
     WHERE (v.updated_at, v.message_id) > (${sinceMs}, ${sinceId})
     ORDER BY v.updated_at ASC, v.message_id ASC
     LIMIT ${BATCH_LIMIT}
  `);
  const rows = Array.isArray(res)
    ? (res as unknown as VerdictRow[])
    : ((res as unknown as { rows: VerdictRow[] }).rows ?? []);
  return rows;
}

/**
 * Build the event payload the frontend's `message_analyzed` handler expects.
 *
 * It replaces the whole row, so every field the message card renders has to be
 * present: dropping `username` or `content` would blank the card the moment a
 * verdict arrived.
 */
function toMessageRecord(
  row: VerdictRow,
  durationMs: number | null,
): MessageRecord {
  return {
    id: row.message_id,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    user_id: row.user_id,
    username: row.username ?? "",
    avatar_url: row.avatar_url,
    content: row.content ?? "",
    edited_content: row.edited_content,
    created_at: Number(row.created_at),
    edited_at: null,
    deleted_at: null,
    type: "text",
    is_reply: null,
    is_forward: null,
    is_crosspost: null,
    reference_message_id: null,
    reference_channel_id: null,
    reference_guild_id: null,
    metadata: row.metadata,
    // The QUEUE state, which is what the worker sets: 'analyzed' means the
    // worker is finished, and says nothing about the outcome.
    ai_status: "analyzed",
    // The JUDGEMENT, from `verdicts`. These are the fields the badge reads;
    // without them the frontend falls back to the queue state and, for an
    // analyzed message, renders "unjudged".
    verdict_status: row.status as MessageRecord["verdict_status"],
    verdict_severity: row.severity as MessageRecord["verdict_severity"],
    verdict_score: row.score,
    verdict_confidence: row.confidence,
    verdict_flags: row.flags,
    verdict_categories: row.categories,
    verdict_recommended_action:
      row.recommended_action as MessageRecord["verdict_recommended_action"],
    verdict_analysis: row.analysis,
    verdict_model: row.model,
    verdict_policy_version: row.policy_version,
    // The worker writes the verdict duration on the `verdicts` row, and the
    // badge appends it to the label. It used to read
    // `messages.ai_analysis_duration_ms`, which the worker never writes, so
    // the duration was always missing from the live badge.
    ai_analysis_duration_ms: durationMs,
  } as MessageRecord;
}

let timer: ReturnType<typeof setInterval> | null = null;
let broadcaster: EventBroadcaster | undefined;
let running = false;

/**
 * Start high enough to catch everything written while this process was down,
 * but not so high that the backlog floods the browser on a restart.
 */
let cursorSince = Date.now() - 60_000;
/** Tiebreak for rows sharing cursorSince's millisecond. Empty string sorts
 *  first, so the first tick replays that millisecond and then moves on. */
let cursorId = "";

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await fetchUnnotified(cursorSince, cursorId);
    if (rows.length === 0) return;

    for (const row of rows) {
      // Advance the cursor per row, not per batch: if publishing throws
      // halfway, the next tick resumes from the last row actually sent
      // rather than replaying or skipping the whole batch.
      const updatedAt = Number(row.updated_at);
      if (Number.isFinite(updatedAt) && updatedAt >= cursorSince) {
        cursorSince = updatedAt;
        cursorId = row.message_id;
      }
      try {
        await broadcaster?.messageAnalyzed(
          toMessageRecord(row, row.duration_ms),
        );
      } catch (error) {
        // One bad verdict must not stall the rest, and must not wedge the
        // cursor — leave it where it is so the next tick retries this row.
        logger.warn(
          {
            messageId: row.message_id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to publish message_analyzed",
        );
      }
    }

    logger.debug({ count: rows.length }, "published verdict updates");
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "verdict notifier tick failed",
    );
  } finally {
    running = false;
  }
}

export function startVerdictNotifier(broadcasterArg: EventBroadcaster): void {
  if (!config.VERDICT_NOTIFY_ENABLED) {
    logger.info("Verdict notifications disabled by config");
    return;
  }
  if (timer) return;
  broadcaster = broadcasterArg;
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, batch: BATCH_LIMIT },
    "Starting verdict notifier",
  );
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();
}

export function stopVerdictNotifier(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  broadcaster = undefined;
}
