import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  like,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { config } from "../../shared/config/index.js";
import { getDatabase } from "../../shared/database/index.js";
import type { PageResult } from "../../shared/index.js";
import {
  pgAttachmentsTable,
  pgMessagesTable,
  pgVerdictsTable,
} from "../../shared/index.js";
import { createChildLogger } from "../../shared/logger/index.js";
import { mapMessageRow } from "../../shared/utils/messageMapper.js";
import type {
  MessageCreate,
  MessageQuery,
  MessageUpdate,
} from "./messages.schema.js";

/**
 * Thread/channel IDs to exclude from all message queries.
 * Messages in these threads (e.g. bot/selfbot spam) are skipped
 * both at capture time (discord-gateway) and when serving data
 * (backend API). Configured via EXCLUDED_THREAD_IDS and EXCLUDED_CHANNEL_IDS.
 */
const EXCLUDED_THREAD_IDS = config.EXCLUDED_THREAD_IDS;

const logger = createChildLogger("messages.repository");

/**
 * Message columns plus the joined verdict, aliased so `mapMessageRow` can pick
 * them up as `verdict_*`.
 *
 * The join is LEFT because most messages have no verdict at all — anything
 * still queued, or analysed by the old pipeline before the rewrite. An INNER
 * join here would silently hide every unanalysed message from the dashboard.
 */
const messageWithVerdict = {
  ...getTableColumns(pgMessagesTable),
  verdict_status: pgVerdictsTable.status,
  verdict_severity: pgVerdictsTable.severity,
  verdict_score: pgVerdictsTable.score,
  verdict_confidence: pgVerdictsTable.confidence,
  verdict_flags: pgVerdictsTable.flags,
  verdict_categories: pgVerdictsTable.categories,
  verdict_recommended_action: pgVerdictsTable.recommended_action,
  verdict_analysis: pgVerdictsTable.analysis,
  verdict_evidence: pgVerdictsTable.evidence,
  verdict_model: pgVerdictsTable.model,
  verdict_updated_at: pgVerdictsTable.updated_at,
};

export interface AttachmentResult {
  id: string;
  message_id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  filename: string;
  size: number;
  type: string;
  discord_url: string;
  uploaded_url: string | null;
  upload_status: string;
  upload_error: string | null;
  created_at: number;
  uploaded_at: number | null;
}

type MessageRow = ReturnType<typeof mapMessageRow>;

export type { MessageRow };

/**
 * Build the NULL-safe "exclude spam threads" condition. Non-thread messages
 * (NULL thread_id) are always kept; thread messages are kept only when their
 * thread is not in the configured exclusion list.
 */
function excludeSpamThreads(): SQL | undefined {
  if (EXCLUDED_THREAD_IDS.length === 0) return undefined;
  return or(
    isNull(pgMessagesTable.thread_id),
    notInArray(pgMessagesTable.thread_id, EXCLUDED_THREAD_IDS),
  );
}

/** Normalize a raw attachment DB row to the API shape. */
function mapAttachmentRow(r: Record<string, unknown>): AttachmentResult {
  return {
    id: String(r.id ?? ""),
    message_id: String(r.message_id ?? ""),
    guild_id: String(r.guild_id ?? ""),
    channel_id: String(r.channel_id ?? ""),
    thread_id: (r.thread_id as string | null) ?? null,
    user_id: String(r.user_id ?? ""),
    filename: String(r.filename ?? ""),
    size: Number(r.size ?? 0),
    type: String(r.type ?? ""),
    discord_url: String(r.discord_url ?? ""),
    uploaded_url: (r.uploaded_url as string | null) ?? null,
    upload_status: String(r.upload_status ?? "pending"),
    upload_error: (r.upload_error as string | null) ?? null,
    created_at: Number(r.created_at ?? 0),
    uploaded_at: (r.uploaded_at as number | null) ?? null,
  };
}

/** Select the first `limit + 1` rows so the caller can derive the next cursor. */
function cursorLimit(limit: number): number {
  return limit + 1;
}

/**
 * The resume token for a page fetched with `limit + 1` rows.
 *
 * THE INDEX IS `limit - 1`, NOT `limit`, AND THAT IS THE WHOLE POINT
 *
 * `cursorLimit()` fetches one row MORE than it returns: the overflow row is
 * proof that another page exists. So the last row actually shown to the caller
 * sits at `rows[limit - 1]`, and the cursor must be built from THAT row — it is
 * the position the next page has to resume strictly after.
 *
 * Using `rows[limit]` instead (the overflow row itself) is off by one and loses
 * a row at every page boundary: the cursor points at a row the client never
 * received, the next page filters strictly `< cursor`, and that row is
 * therefore skipped forever. It is a silent data-loss bug, not a visible
 * error — the page still looks plausible.
 *
 * This was the bug in all four cursor-paginated queries in this file
 * (`findMany`, `findByChannel`, `getImageMessages`, `getAttachmentsByChannel`)
 * before `getReviewMessages`/`getRecentEdits` were added; the index is spelled
 * once here so the next one cannot repeat it.
 *
 * Stringified because `PageResult.nextCursor` is `string | null` and the queries
 * compare it with `Number(query.cursor)` on the way back in — one canonical
 * representation at the boundary, not two.
 *
 * Returns null when the fetched row count does not exceed `limit`, i.e. this
 * was the final page.
 */
function nextCursorAt<T extends { created_at: unknown }>(
  rows: T[],
  limit: number,
): string | null {
  if (rows.length <= limit) return null;
  return String(rows[limit - 1].created_at);
}

/**
 * The review queue's sort key, defined ONCE in JS and once in SQL — and the two
 * pairs must agree.
 *
 * WHY THEY ARE DUPLICATED AT ALL
 *
 * `getReviewMessages` uses this key twice: once in ORDER BY, once inside the
 * cursor comparison. Writing it as a single SQL expression and reusing that
 * expression in both places is what makes drift impossible. It still has to
 * exist twice overall — once as SQL text for the query, once as a JS function
 * for encoding a returned row into the next cursor — so the pairing is
 * asserted by the tests rather than by the compiler.
 *
 * `actionRankOf` mirrors `reviewActionRank()`: ranking rather than sorting the
 * raw string is what puts `delete` above `escalate` above `review`, because
 * those are the tiers a moderator acts on. `none`/NULL lands in bucket 0 and
 * therefore sorts last.
 */
const ACTION_RANKS: Record<string, number> = {
  delete: 3,
  escalate: 2,
  review: 1,
};

const SEVERITY_RANKS: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  none: 1,
};

function actionRankOf(recommendedAction: unknown): number {
  if (typeof recommendedAction !== "string") return 0;
  return ACTION_RANKS[recommendedAction] ?? 0;
}

function severityRankOf(severity: unknown): number {
  if (typeof severity !== "string") return 1;
  return SEVERITY_RANKS[severity] ?? 1;
}

function reviewActionRank(): SQL {
  return sql`CASE ${pgVerdictsTable.recommended_action}
    WHEN 'delete' THEN 3
    WHEN 'escalate' THEN 2
    WHEN 'review' THEN 1
    ELSE 0 END`;
}

/**
 * Severity as a comparable number. The column is a text enum, so `desc()` on it
 * would sort lexically ("none" > "low" > "critical" > "high"), which is why the
 * frontend re-sorts severity for display too.
 */
function reviewSeverityKey(): SQL {
  return sql`CASE ${pgVerdictsTable.severity}
    WHEN 'critical' THEN 5
    WHEN 'high' THEN 4
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 2
    ELSE 1 END`;
}

/** The full review-queue sort key, ordered most-important first. */
function reviewOrderBy(): SQL[] {
  return [
    desc(reviewActionRank()),
    desc(reviewSeverityKey()),
    desc(pgMessagesTable.created_at),
    desc(pgMessagesTable.id),
  ];
}

/**
 * A position in the review queue, resolved to the raw column values a row
 * comparison needs.
 *
 * Deliberately stores the RANK (`3` for delete), not the string, so the decode
 * side needs no CASE of its own — the same numbering is used on both sides of
 * the comparison, which is the whole point of the encoding.
 */
interface ReviewCursor {
  action: number;
  severity: number;
  created_at: number;
  id: string;
}

/** Encode/decode are lenient on purpose: a malformed cursor means "first page". */
function decodeReviewCursor(cursor?: string): ReviewCursor | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, "base64").toString("utf-8"),
    ) as Partial<ReviewCursor>;
    if (
      typeof raw.action !== "number" ||
      typeof raw.severity !== "number" ||
      typeof raw.created_at !== "number" ||
      typeof raw.id !== "string"
    ) {
      return null;
    }
    return {
      action: raw.action,
      severity: raw.severity,
      created_at: raw.created_at,
      id: raw.id,
    };
  } catch {
    return null;
  }
}

function encodeReviewCursor(cursor: ReviewCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

/** A page of review-queue rows plus the position to resume from. */
export interface ReviewPageResult {
  results: Record<string, unknown>[];
  nextCursor: string | null;
}

/** A position in the edit log: `(edited_at, id)`, both needed for a total order. */
interface EditCursor {
  edited_at: number;
  id: string;
}

/** A page of edit rows plus the position to resume from. */
export interface EditPageResult {
  results: {
    id: string;
    message_id: string;
    old_content: string;
    new_content: string;
    edited_at: number;
    channel_id: string | null;
    channel_name: string | null;
    username: string | null;
  }[];
  nextCursor: string | null;
}

/** A malformed cursor degrades to "no cursor" — the first page — never to a throw. */
function decodeEditCursor(cursor?: string): EditCursor | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, "base64").toString("utf-8"),
    ) as Partial<EditCursor>;
    if (typeof raw.edited_at !== "number" || typeof raw.id !== "string") {
      return null;
    }
    return { edited_at: raw.edited_at, id: raw.id };
  } catch {
    return null;
  }
}

function encodeEditCursor(cursor: EditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

export class MessagesRepository {
  async findMany(query: MessageQuery): Promise<PageResult<MessageRow>> {
    const db = getDatabase();
    const limit = query.limit ?? 50;
    const conditions: SQL[] = [];

    if (query.guildId) {
      conditions.push(eq(pgMessagesTable.guild_id, query.guildId));
    }
    if (query.channelId) {
      conditions.push(eq(pgMessagesTable.channel_id, query.channelId));
    }
    if (query.userId) {
      conditions.push(eq(pgMessagesTable.user_id, query.userId));
    }
    if (query.status) {
      // Pipeline position, e.g. `dead`.
      conditions.push(eq(pgMessagesTable.ai_status, query.status));
    }
    if (query.verdict) {
      // Moderation outcome. Filtering on messages.ai_status here would return
      // nothing at all, because the worker only ever writes `analyzed` to it.
      conditions.push(eq(pgVerdictsTable.status, query.verdict));
    }
    if (query.needsReview) {
      conditions.push(inArray(pgVerdictsTable.status, ["warn", "flagged"]));
    }
    if (query.cursor) {
      conditions.push(lt(pgMessagesTable.created_at, Number(query.cursor)));
    }

    // Exclude spam threads (NULL-safe: non-thread messages are kept)
    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await db
      .select(messageWithVerdict)
      .from(pgMessagesTable)
      .leftJoin(
        pgVerdictsTable,
        eq(pgVerdictsTable.message_id, pgMessagesTable.id),
      )
      .where(where)
      .orderBy(desc(pgMessagesTable.created_at))
      .limit(cursorLimit(limit));

    const data = rows
      .slice(0, limit)
      .map((r) => mapMessageRow(r as Record<string, unknown>));
    const nextCursor = nextCursorAt(rows, limit);

    logger.debug({ count: data.length, nextCursor }, "Found messages");
    return { data, nextCursor };
  }

  /**
   * One message with its joined verdict.
   *
   * Left-joined like the list query: most messages have no verdict, and an
   * inner join here would make the detail view 404 on anything unjudged.
   */
  async findById(id: string) {
    const db = getDatabase();
    const [row] = await db
      .select(messageWithVerdict)
      .from(pgMessagesTable)
      .leftJoin(
        pgVerdictsTable,
        eq(pgVerdictsTable.message_id, pgMessagesTable.id),
      )
      .where(eq(pgMessagesTable.id, id))
      .limit(1);

    if (!row) return null;
    return mapMessageRow(row as Record<string, unknown>);
  }

  /**
   * Every analysis attempt for a message, oldest first.
   *
   * This is the only way to answer "why is this one message stuck?" — the
   * verdict table cannot, because a message that never got a verdict has no row
   * there at all. Append-only, so it is a complete history of what the worker
   * tried and what came back.
   */
  async getAnalysisAttempts(messageId: string): Promise<
    Array<{
      attempt: number;
      outcome: string;
      error_code: string | null;
      error_message: string | null;
      duration_ms: number | null;
      model: string | null;
      worker_id: string | null;
      prompt_tokens: number | null;
      created_at: number;
    }>
  > {
    const db = getDatabase();
    const result = await db.execute(sql`
      SELECT attempt, outcome, error_code, error_message,
             duration_ms, model, worker_id, prompt_tokens, created_at
      FROM analysis_attempts
      WHERE message_id = ${messageId}
      ORDER BY created_at ASC, id ASC
    `);
    return (result.rows as Record<string, unknown>[]).map((r) => ({
      attempt: Number(r.attempt),
      outcome: String(r.outcome),
      error_code: (r.error_code as string | null) ?? null,
      error_message: (r.error_message as string | null) ?? null,
      duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
      model: (r.model as string | null) ?? null,
      worker_id: (r.worker_id as string | null) ?? null,
      prompt_tokens: r.prompt_tokens === null ? null : Number(r.prompt_tokens),
      created_at: Number(r.created_at),
    }));
  }

  /**
   * Edit history for a message: previous content snapshots (newest first).
   * Stored in message_edits by the gateway's message-capture module.
   */
  async getEditHistory(
    messageId: string,
  ): Promise<Array<{ old_content: string; edited_at: number }>> {
    const db = getDatabase();
    const result = await db.execute(sql`
      SELECT old_content, edited_at
      FROM message_edits
      WHERE message_id = ${messageId}
      ORDER BY edited_at DESC
      LIMIT 50
    `);
    return ((result.rows as Record<string, unknown>[]) || []).map((r) => ({
      old_content: String(r.old_content ?? ""),
      edited_at: Number(r.edited_at ?? 0),
    }));
  }

  async findByChannel(
    channelId: string,
    query: MessageQuery,
  ): Promise<PageResult<MessageRow>> {
    const db = getDatabase();
    const limit = query.limit ?? 50;
    const conditions: SQL[] = [eq(pgMessagesTable.channel_id, channelId)];

    if (query.cursor) {
      conditions.push(lt(pgMessagesTable.created_at, Number(query.cursor)));
    }

    // Exclude spam threads (NULL-safe)
    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    const rows = await db
      .select()
      .from(pgMessagesTable)
      .where(and(...conditions))
      .orderBy(desc(pgMessagesTable.created_at))
      .limit(cursorLimit(limit));

    const data = rows
      .slice(0, limit)
      .map((r) => mapMessageRow(r as Record<string, unknown>));
    const nextCursor = nextCursorAt(rows, limit);

    return { data, nextCursor };
  }

  /**
   * Async generator that yields messages ONE AT A TIME for WS streaming.
   * Each `.next()` runs its own bounded DB query (limit+1) advancing on the
   * `created_at` cursor, so memory stays flat and the caller can emit one WS
   * frame per message (no 50-row batch). Stops when a page returns < limit.
   */
  async *streamMany(
    query: MessageQuery,
    pageSize = 50,
  ): AsyncGenerator<MessageRow, void, unknown> {
    const conditions: SQL[] = [];

    if (query.guildId) {
      conditions.push(eq(pgMessagesTable.guild_id, query.guildId));
    }
    if (query.channelId) {
      conditions.push(eq(pgMessagesTable.channel_id, query.channelId));
    }
    if (query.userId) {
      conditions.push(eq(pgMessagesTable.user_id, query.userId));
    }
    if (query.status) {
      conditions.push(eq(pgMessagesTable.ai_status, query.status));
    }
    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    let cursor: string | undefined = query.cursor;

    while (true) {
      const pageConditions = where ? [where] : [];
      if (cursor) {
        pageConditions.push(lt(pgMessagesTable.created_at, Number(cursor)));
      }
      const pageWhere =
        pageConditions.length > 0 ? and(...pageConditions) : undefined;

      const db = getDatabase();
      const rows = await db
        .select()
        .from(pgMessagesTable)
        .where(pageWhere)
        .orderBy(desc(pgMessagesTable.created_at))
        .limit(cursorLimit(pageSize));

      if (rows.length === 0) return;

      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      for (const r of pageRows) {
        yield mapMessageRow(r as Record<string, unknown>);
      }

      if (!hasMore) return;
      cursor = String(rows[pageSize - 1].created_at);
    }
  }

  async create(data: MessageCreate) {
    const db = getDatabase();
    const id = crypto.randomUUID();

    const [row] = await db
      .insert(pgMessagesTable)
      .values({
        id,
        guild_id: data.guildId,
        channel_id: data.channelId,
        thread_id: data.threadId ?? null,
        user_id: data.userId,
        username: data.username,
        avatar_url: data.avatarUrl ?? null,
        content: data.content,
        edited_content: null,
        created_at: Date.now(),
        edited_at: null,
        deleted_at: null,
        type: data.type ?? "text",
        metadata: null,
        ai_status: "pending",
        is_reply: data.isReply ?? false,
        is_forward: data.isForward ?? false,
        is_crosspost: data.isCrosspost ?? false,
        reference_message_id: data.referenceMessageId ?? null,
        reference_channel_id: data.referenceChannelId ?? null,
        reference_guild_id: data.referenceGuildId ?? null,
      })
      .returning();

    return mapMessageRow(row as Record<string, unknown>);
  }

  async update(id: string, data: MessageUpdate) {
    const db = getDatabase();

    const setData: Partial<typeof pgMessagesTable.$inferInsert> = {};

    if (data.editedContent !== undefined) {
      setData.edited_content = data.editedContent;
    }
    if (data.aiStatus !== undefined) {
      setData.ai_status = data.aiStatus;
    }
    if (data.aiAnalysis !== undefined) {
      setData.ai_analysis = data.aiAnalysis;
    }
    if (data.aiCategories !== undefined) {
      setData.ai_categories = data.aiCategories;
    }
    if (data.aiSeverity !== undefined) {
      setData.ai_severity = data.aiSeverity;
    }
    if (data.aiConfidence !== undefined) {
      setData.ai_confidence = data.aiConfidence;
    }

    if (Object.keys(setData).length === 0) return this.findById(id);

    const [row] = await db
      .update(pgMessagesTable)
      .set(setData)
      .where(eq(pgMessagesTable.id, id))
      .returning();

    if (!row) return null;
    return mapMessageRow(row as Record<string, unknown>);
  }

  /**
   * Messages a human should look at: verdict in (warn, flagged), plus any that
   * ran out of attempts (`dead`).
   *
   * This used to be `messages.ai_status IN ('warn','flagged')`, which returned
   * an empty list forever once the new worker started writing only `analyzed` to
   * that column. The judgement lives in `verdicts.status` now.
   *
   * CURSOR PAGINATION MUST MATCH THE ORDER BY
   *
   * This query does not sort by recency — it sorts actionable-first, then
   * severity, then newest, which is the order a moderator works the queue in. A
   * `created_at`-only cursor would therefore be wrong here: every page re-sorts
   * independently, so the same row reappears on page 2 while rows from page 1
   * that fell below the cut are silently lost.
   *
   * So the cursor carries the WHOLE sort key (action rank, severity, created_at,
   * id) and the WHERE clause replays it as a nested lexicographic comparison
   * against the same key expressions the ORDER BY uses. Both sides read
   * `reviewActionRank()` / `reviewSeverityKey()` — one definition each — so the
   * comparison cannot drift from the sort. `id` is the final tiebreak in the
   * ORDER BY precisely so that a cursor has a total order to resume from: two
   * rows sharing (action, severity, created_at) would otherwise be returned in
   * an arbitrary order and could be duplicated or skipped across pages.
   */
  async getReviewMessages(
    channelId?: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<ReviewPageResult> {
    const db = getDatabase();
    const needsReview = or(
      inArray(pgVerdictsTable.status, ["warn", "flagged"]),
      eq(pgMessagesTable.ai_status, "dead"),
    );
    // or() returns undefined only if every branch is undefined, which cannot
    // happen with literal arguments — but the type says it can.
    const conditions: SQL[] = [needsReview as SQL];

    if (channelId) {
      conditions.push(eq(pgMessagesTable.channel_id, channelId));
    }

    const at = decodeReviewCursor(cursor);
    if (at) {
      conditions.push(
        sql`(${reviewActionRank()} < ${at.action}
             or (${reviewActionRank()} = ${at.action} and (
               ${reviewSeverityKey()} < ${at.severity}
               or (${reviewSeverityKey()} = ${at.severity} and (
                 ${pgMessagesTable.created_at} < ${at.created_at}
                 or (${pgMessagesTable.created_at} = ${at.created_at}
                     and ${pgMessagesTable.id} < ${at.id})
               ))
             )))`,
      );
    }

    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    const rows = await db
      .select({
        id: pgMessagesTable.id,
        guild_id: pgMessagesTable.guild_id,
        channel_id: pgMessagesTable.channel_id,
        user_id: pgMessagesTable.user_id,
        username: pgMessagesTable.username,
        avatar_url: pgMessagesTable.avatar_url,
        content: pgMessagesTable.content,
        type: pgMessagesTable.type,
        created_at: pgMessagesTable.created_at,
        // Legacy `messages.ai_*` — the new worker never writes these, so they
        // are null for anything judged after the rewrite. The live judgement is
        // the verdict_* columns below, joined from `verdicts`.
        ai_severity: pgMessagesTable.ai_severity,
        ai_confidence: pgMessagesTable.ai_confidence,
        ai_analysis: pgMessagesTable.ai_analysis,
        is_reply: pgMessagesTable.is_reply,
        is_forward: pgMessagesTable.is_forward,
        is_crosspost: pgMessagesTable.is_crosspost,
        reference_message_id: pgMessagesTable.reference_message_id,
        reference_channel_id: pgMessagesTable.reference_channel_id,
        reference_guild_id: pgMessagesTable.reference_guild_id,
        // Retry state, so the review queue can distinguish "flagged, fine" from
        // "never finished, needs a human".
        ai_status: pgMessagesTable.ai_status,
        attempts: pgMessagesTable.attempts,
        worker_id: pgMessagesTable.worker_id,
        verdict_status: pgVerdictsTable.status,
        verdict_severity: pgVerdictsTable.severity,
        verdict_score: pgVerdictsTable.score,
        verdict_confidence: pgVerdictsTable.confidence,
        verdict_flags: pgVerdictsTable.flags,
        verdict_categories: pgVerdictsTable.categories,
        verdict_recommended_action: pgVerdictsTable.recommended_action,
        verdict_analysis: pgVerdictsTable.analysis,
        verdict_evidence: pgVerdictsTable.evidence,
        verdict_model: pgVerdictsTable.model,
        verdict_updated_at: pgVerdictsTable.updated_at,
      })
      .from(pgMessagesTable)
      .leftJoin(
        pgVerdictsTable,
        eq(pgVerdictsTable.message_id, pgMessagesTable.id),
      )
      .where(and(...conditions))
      // Actionable first, then most severe, then newest. Read from
      // `reviewOrderBy()` so the sort and the cursor comparison cannot drift.
      .orderBy(...reviewOrderBy())
      .limit(cursorLimit(limit));

    // `limit + 1` fetched: the overflow row only proves another page exists.
    const results = (rows.slice(0, limit) ?? []) as Record<string, unknown>[];
    // Cursor comes from the LAST RETURNED row (index `limit - 1`), not the
    // overflow row at index `limit` — see `nextCursorAt` for why that
    // distinction costs a row per page boundary if you get it backwards.
    const last = rows.length > limit ? rows[limit - 1] : null;
    const nextCursor =
      last && results.length === limit
        ? encodeReviewCursor({
            action: actionRankOf(last.verdict_recommended_action),
            severity: severityRankOf(last.verdict_severity),
            created_at: Number(last.created_at),
            id: String(last.id),
          })
        : null;

    return { results, nextCursor };
  }

  async delete(id: string): Promise<boolean> {
    const db = getDatabase();
    const result = await db
      .delete(pgMessagesTable)
      .where(eq(pgMessagesTable.id, id));

    return (result.rowCount ?? 0) > 0;
  }

  async getImageMessages(
    guildId: string,
    limit: number = 50,
  ): Promise<PageResult<MessageRow>> {
    const db = getDatabase();

    // Subquery: find distinct message_ids from attachments with image MIME type
    const attachmentConditions: SQL[] = [
      eq(pgAttachmentsTable.guild_id, guildId),
      like(pgAttachmentsTable.type, "image/%"),
    ];
    // Exclude spam threads (NULL-safe for non-thread messages)
    const excludeThreads =
      EXCLUDED_THREAD_IDS.length > 0
        ? or(
            isNull(pgAttachmentsTable.thread_id),
            notInArray(pgAttachmentsTable.thread_id, EXCLUDED_THREAD_IDS),
          )
        : undefined;
    if (excludeThreads) attachmentConditions.push(excludeThreads);

    const imageMsgIds = db
      .select({ id: pgAttachmentsTable.message_id })
      .from(pgAttachmentsTable)
      .where(and(...attachmentConditions))
      .orderBy(desc(pgAttachmentsTable.created_at))
      .limit(cursorLimit(limit));

    // Fetch full message rows for those IDs
    const rows = await db
      .select()
      .from(pgMessagesTable)
      .where(inArray(pgMessagesTable.id, imageMsgIds))
      .orderBy(desc(pgMessagesTable.created_at))
      .limit(cursorLimit(limit));

    const data = rows
      .slice(0, limit)
      .map((r) => mapMessageRow(r as Record<string, unknown>));
    const nextCursor = nextCursorAt(rows, limit);

    logger.debug({ count: data.length, nextCursor }, "Found image messages");
    return { data, nextCursor };
  }

  async getAttachmentsByChannel(
    channelId: string,
    query: MessageQuery,
  ): Promise<PageResult<AttachmentResult>> {
    const db = getDatabase();
    const limit = query.limit ?? 50;
    const conditions: SQL[] = [eq(pgAttachmentsTable.channel_id, channelId)];

    // Detail view: narrow to the selected message so we don't show
    // everyone else's images from the same channel.
    if (query.messageId) {
      conditions.push(eq(pgAttachmentsTable.message_id, query.messageId));
    }

    if (query.cursor) {
      conditions.push(lt(pgAttachmentsTable.created_at, Number(query.cursor)));
    }

    const rows = await db
      .select()
      .from(pgAttachmentsTable)
      .where(and(...conditions))
      .orderBy(desc(pgAttachmentsTable.created_at))
      .limit(cursorLimit(limit));

    const data = rows.map((r) =>
      mapAttachmentRow(r as Record<string, unknown>),
    );

    // `nextCursorAt` reads the LAST RETURNED row (index `limit - 1`), not the
    // overflow row at index `limit`. An earlier comment here claimed index
    // `limit` "matches the other cursor-paginated queries" — it did, and that
    // was the bug in all of them: it skipped one row per page boundary. See
    // `nextCursorAt` for the full explanation.
    const nextCursor = nextCursorAt(rows, limit);
    const trimmed = data.slice(0, limit);

    return { data: trimmed, nextCursor };
  }

  /**
   * Per-hour message volume for the last `days` days, grouped by channel.
   * Powers the public Activity Heatmap (read-only, no write scope).
   * Returns a flat list of { channel_id, hour (0-23), count } buckets.
   */
  async getActivity(days = 30) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await db.execute(sql`
      SELECT
        m.channel_id,
        COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''), m.channel_id) AS channel_name,
        EXTRACT(HOUR FROM to_timestamp(m.created_at / 1000))::int AS hour,
        COUNT(*)::int AS c
      FROM messages m
      WHERE m.created_at >= ${since}
      GROUP BY m.channel_id, channel_name, hour
      ORDER BY channel_name, hour
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];
    return rows.map((r) => ({
      channelId: String(r.channel_id ?? "unknown"),
      channelName: String(r.channel_name ?? r.channel_id ?? "unknown"),
      hour: Number(r.hour ?? 0),
      count: Number(r.c ?? 0),
    }));
  }

  /**
   * Recent message edits across the server (evasion-signal tracker).
   * Public, read-only. Joins message_edits → messages for context.
   *
   * Cursor-paged on `(edited_at, id)`. Unlike the review queue this one really
   * does sort by recency, so a single timestamp cursor would almost be enough —
   * but `id` is the tiebreak for the same reason as everywhere else: two edits
   * in the same millisecond would otherwise be returned in an arbitrary order
   * and could be duplicated or dropped across a page boundary.
   */
  async getRecentEdits(
    limit = 50,
    channelId?: string,
    cursor?: string,
  ): Promise<EditPageResult> {
    const db = getDatabase();

    const filters: SQL[] = [];
    if (channelId) filters.push(sql`m.channel_id = ${channelId}`);

    const at = decodeEditCursor(cursor);
    if (at) {
      filters.push(
        sql`(e.edited_at < ${at.edited_at} or (e.edited_at = ${at.edited_at} and e.id < ${at.id}))`,
      );
    }

    const result = await db.execute(sql`
      SELECT
        e.id,
        e.message_id,
        e.old_content,
        e.edited_at,
        m.channel_id,
        COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''), m.channel_id) AS channel_name,
        m.username,
        COALESCE(m.edited_content, m.content) AS new_content
      FROM message_edits e
      JOIN messages m ON m.id = e.message_id
      ${filters.length > 0 ? sql`WHERE ${and(...filters)}` : sql``}
      ORDER BY e.edited_at DESC, e.id DESC
      LIMIT ${cursorLimit(limit)}
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];

    // The `limit + 1`-th row is fetched purely to detect "there is more"; it is
    // not part of `results`. The cursor is built from the last RETURNED row
    // (index `limit - 1`) — see `nextCursorAt` for why index `limit` loses a
    // row per page boundary.
    const results = rows.slice(0, limit).map((r) => ({
      id: String(r.id),
      message_id: String(r.message_id),
      old_content: r.old_content ? String(r.old_content) : "",
      new_content: r.new_content ? String(r.new_content) : "",
      edited_at: r.edited_at ? Number(r.edited_at) : 0,
      channel_id: r.channel_id ? String(r.channel_id) : null,
      channel_name: r.channel_name ? String(r.channel_name) : null,
      username: r.username ? String(r.username) : null,
    }));

    const last = rows.length > limit ? rows[limit - 1] : undefined;
    const nextCursor = last
      ? encodeEditCursor({
          edited_at: Number(last.edited_at ?? 0),
          id: String(last.id),
        })
      : null;

    return { results, nextCursor };
  }

  /**
   * Distinct guilds present in the message archive (drives the guild picker).
   */
  async listGuilds(): Promise<
    Array<{ id: string; name: string; icon: string | null }>
  > {
    const db = getDatabase();
    const rows = await db
      .selectDistinct({ guild_id: pgMessagesTable.guild_id })
      .from(pgMessagesTable)
      .orderBy(pgMessagesTable.guild_id);
    return rows.map((row) => ({
      id: String(row.guild_id ?? ""),
      name: `Guild ${String(row.guild_id).slice(0, 8)}`,
      icon: null,
    }));
  }

  /**
   * Text channels for a guild, derived from the message archive
   * (drives the channel picker).
   */
  async listTextChannels(
    guildId: string,
  ): Promise<Array<{ id: string; name: string; type: "text" }>> {
    const db = getDatabase();
    const rows = await db
      .selectDistinct({ channel_id: pgMessagesTable.channel_id })
      .from(pgMessagesTable)
      .where(eq(pgMessagesTable.guild_id, guildId))
      .orderBy(pgMessagesTable.channel_id);
    return rows.map((row) => ({
      id: String(row.channel_id ?? ""),
      name: `Channel ${String(row.channel_id).slice(0, 8)}`,
      type: "text" as const,
    }));
  }
}

export const messagesRepository = new MessagesRepository();
