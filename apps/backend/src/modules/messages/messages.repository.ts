import type { Prisma } from "@gmw/db/prisma/generated/client";
import { config } from "../../shared/config/index.js";
import { getDatabase } from "../../shared/database/index.js";
import type { PageResult } from "../../shared/index.js";
import { createChildLogger } from "../../shared/logger/index.js";
import { readChannelName } from "../../shared/utils/channelName.js";
import { localHour } from "../../shared/utils/localTime.js";
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
 *
 * Prisma returns the nested `verdicts` object rather than flat `verdict_*`
 * columns, so `flattenVerdict` below re-projects it into the shape
 * `mapMessageRow` expects. Doing that in one place keeps every caller of the
 * mapper free of relation-handling.
 */
const messageWithVerdict = {
  id: true,
  guild_id: true,
  channel_id: true,
  thread_id: true,
  user_id: true,
  username: true,
  avatar_url: true,
  content: true,
  edited_content: true,
  created_at: true,
  edited_at: true,
  deleted_at: true,
  type: true,
  metadata: true,
  ai_status: true,
  attempts: true,
  worker_id: true,
  lease_until: true,
  ready_for_work_at: true,
  ai_moderation_flags: true,
  ai_moderation_score: true,
  ai_analysis: true,
  ai_categories: true,
  ai_confidence: true,
  ai_analyzed_at: true,
  ai_analysis_duration_ms: true,
  ai_error: true,
  is_reply: true,
  is_forward: true,
  is_crosspost: true,
  reference_message_id: true,
  reference_channel_id: true,
  reference_guild_id: true,
  verdicts: {
    select: {
      status: true,
      score: true,
      confidence: true,
      flags: true,
      categories: true,
      reason: true,
      analysis: true,
      evidence: true,
      model: true,
      updated_at: true,
      // Only the gateway's enforcer writes this, which is what lets the
      // dashboard separate a bot deletion from a human one.
      // `messages.deleted_at` cannot: Discord's messageDelete fires for both.
      auto_delete_state: true,
    },
  },
} satisfies Prisma.messagesSelect;

type MessageWithVerdict = Prisma.messagesGetPayload<{
  select: typeof messageWithVerdict;
}>;

/**
 * Re-project a Prisma row carrying a nested `verdicts` object into the flat
 * `verdict_*` shape `mapMessageRow` reads. A missing verdict leaves every
 * `verdict_*` key null, which the mapper already treats as "not judged".
 *
 * Generic over the select so both the wide `messageWithVerdict` and the narrow
 * `reviewSelect` can be flattened without the narrower one being widened to
 * satisfy the wider's type.
 */
function flattenVerdict<
  T extends { verdicts?: { status: unknown; score: unknown } | null },
>(row: T): Record<string, unknown> {
  const { verdicts: v, ...message } = row;
  const verdict = v as
    | (Record<string, unknown> & { status?: unknown; score?: unknown })
    | null
    | undefined;
  return {
    ...message,
    verdict_status: verdict?.status ?? null,
    verdict_score: verdict?.score ?? null,
    verdict_confidence: verdict?.confidence ?? null,
    verdict_flags: verdict?.flags ?? null,
    verdict_categories: verdict?.categories ?? null,
    verdict_reason: verdict?.reason ?? null,
    verdict_analysis: verdict?.analysis ?? null,
    verdict_evidence: verdict?.evidence ?? null,
    verdict_model: verdict?.model ?? null,
    verdict_updated_at: verdict?.updated_at ?? null,
    auto_delete_state: verdict?.auto_delete_state ?? null,
  };
}

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
function excludeSpamThreads(): Prisma.messagesWhereInput | undefined {
  if (EXCLUDED_THREAD_IDS.length === 0) return undefined;
  return {
    OR: [{ thread_id: null }, { thread_id: { notIn: EXCLUDED_THREAD_IDS } }],
  };
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
 * raw string is what puts `deleted` above `clean`, because those are the two
 * dispositions the model can reach. `NULL`/absent lands in bucket 0 and
 * therefore sorts last.
 */
const ACTION_RANKS: Record<string, number> = {
  deleted: 2,
  clean: 1,
};

function actionRankOf(recommendedAction: unknown): number {
  if (typeof recommendedAction !== "string") return 0;
  return ACTION_RANKS[recommendedAction] ?? 0;
}

/**
 * Score as a comparable integer, scaled by 100.
 *
 * This replaces the severity tier that used to sit between the action rank and
 * `created_at` in the queue order: with severity gone, how bad the model thought
 * something was IS the score, so that is what orders it.
 *
 * Scaled to an integer rather than carried as a raw float because the cursor
 * comparison tests this key for EQUALITY. The old SQL cast to `float8` before
 * multiplying so both sides did identical double arithmetic on a float4 input;
 * JS numbers are already float64, so the widening happens for free here.
 * `Math.floor` matches the SQL `FLOOR`, so a negative score would not diverge.
 *
 * Prisma's `orderBy` cannot hold a computed expression, so the queue is ordered
 * in JS. `compareReviewOrder` below is the exact inverse used for the cursor
 * filter, so sort and pagination cannot drift.
 */
function scoreRankOf(score: unknown): number {
  return Math.floor(Number(score ?? 0) * 100);
}

/** The four components the review sort key is built from, all pre-ranked. */
interface ReviewSortKey {
  id: string;
  created_at: bigint | number;
  /** `actionRankOf(verdict.status)` — the cursor stores this, not the string. */
  action: number;
  /** `scoreRankOf(verdict.score)` — `floor(score * 100)`. */
  score: number;
}

/**
 * Order rows by the full review-queue sort key, most-important first: action
 * rank, then score, then recency, then id.
 *
 * `id` is last because a cursor needs a total order — two rows sharing (action,
 * score, created_at) would otherwise be emitted in an arbitrary order and could
 * be duplicated or skipped across a page boundary.
 *
 * Both keys are pre-ranked, so a decoded cursor and a fetched row are directly
 * comparable — which is what lets this one function serve as both the sort and
 * the cursor filter.
 */
function compareReviewOrder(a: ReviewSortKey, b: ReviewSortKey): number {
  return (
    b.action - a.action ||
    b.score - a.score ||
    Number(b.created_at) - Number(a.created_at) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/**
 * A position in the review queue, resolved to the raw column values a row
 * comparison needs.
 *
 * Deliberately stores the RANK (`2` for deleted), not the string, so the decode
 * side needs no CASE of its own — the same numbering is used on both sides of
 * the comparison, which is the whole point of the encoding.
 */
interface ReviewCursor {
  action: number;
  score: number;
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
      typeof raw.score !== "number" ||
      typeof raw.created_at !== "number" ||
      typeof raw.id !== "string"
    ) {
      return null;
    }
    return {
      action: raw.action,
      score: raw.score,
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

/**
 * Columns `getReviewMessages` returns — a narrower set than `messageWithVerdict`
 * (no edit/deletion bookkeeping, no legacy moderation flags) because the review
 * queue renders only these.
 */
const reviewSelect = {
  id: true,
  guild_id: true,
  channel_id: true,
  user_id: true,
  username: true,
  avatar_url: true,
  content: true,
  type: true,
  created_at: true,
  // Legacy `messages.ai_*` — the new worker never writes these, so they are
  // null for anything judged after the rewrite. The live judgement is the
  // verdict_* columns, joined from `verdicts`.
  ai_confidence: true,
  ai_analysis: true,
  is_reply: true,
  is_forward: true,
  is_crosspost: true,
  reference_message_id: true,
  reference_channel_id: true,
  reference_guild_id: true,
  // Retry state, so the review queue can distinguish "flagged, fine" from
  // "never finished, needs a human".
  ai_status: true,
  attempts: true,
  worker_id: true,
  verdicts: {
    select: {
      status: true,
      score: true,
      confidence: true,
      flags: true,
      categories: true,
      reason: true,
      analysis: true,
      evidence: true,
      model: true,
      updated_at: true,
      auto_delete_state: true,
    },
  },
} satisfies Prisma.messagesSelect;

type ReviewRow = Prisma.messagesGetPayload<{ select: typeof reviewSelect }>;

/**
 * How much of the review queue to over-fetch, now that ordering happens in JS.
 *
 * The cursor's sort key cannot be pushed into `orderBy`, so `take` bounds the
 * scan rather than the page, and rows are trimmed after sorting. A factor
 * leaves headroom for the cursor filter to discard rows before the page fills;
 * if it ever truncates a full page, `nextCursor` still advances so paging
 * continues correctly — it just skips rows that sorted below the scan window.
 */
const REVIEW_SCAN_FACTOR = 4;
const REVIEW_MIN_SCAN = 200;

/**
 * Extra attachment rows to scan per page slot when resolving image messages.
 * Only the distinct message ids matter, so a message with N image attachments
 * consumes N rows of the window; this keeps the distinct count above the page
 * size. 4 covers the common case of a few images per message.
 */
const ATTACHMENT_ID_OVERSAMPLE = 4;

type ReviewPageResultRow = Record<string, unknown>;

export class MessagesRepository {
  async findMany(query: MessageQuery): Promise<PageResult<MessageRow>> {
    const db = getDatabase();
    const limit = query.limit ?? 50;
    const conditions: Prisma.messagesWhereInput[] = [];

    if (query.guildId) {
      conditions.push({ guild_id: query.guildId });
    }
    if (query.channelId) {
      conditions.push({ channel_id: query.channelId });
    }
    if (query.userId) {
      conditions.push({ user_id: query.userId });
    }
    if (query.status) {
      // Pipeline position, e.g. `dead`.
      conditions.push({ ai_status: query.status });
    }
    if (query.verdict) {
      // Moderation outcome. Filtering on messages.ai_status here would return
      // nothing at all, because the worker only ever writes `analyzed` to it.
      conditions.push({ verdicts: { is: { status: query.verdict } } });
    }
    if (query.needsReview) {
      conditions.push({ verdicts: { is: { status: "deleted" } } });
    }
    if (query.cursor) {
      conditions.push({ created_at: { lt: BigInt(Number(query.cursor)) } });
    }

    // Exclude spam threads (NULL-safe: non-thread messages are kept)
    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    const rows = await db.messages.findMany({
      where: { AND: conditions },
      orderBy: { created_at: "desc" },
      take: cursorLimit(limit),
      select: messageWithVerdict,
    });

    const data = rows
      .slice(0, limit)
      .map((r) => mapMessageRow(flattenVerdict(r)));
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
    const row = await db.messages.findFirst({
      where: { id },
      take: 1,
      select: messageWithVerdict,
    });

    if (!row) return null;
    return mapMessageRow(flattenVerdict(row));
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
    const rows = await db.analysis_attempts.findMany({
      where: { message_id: messageId },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: {
        attempt: true,
        outcome: true,
        error_code: true,
        error_message: true,
        duration_ms: true,
        model: true,
        worker_id: true,
        prompt_tokens: true,
        created_at: true,
      },
    });
    return rows.map((r) => ({
      attempt: Number(r.attempt),
      outcome: String(r.outcome),
      error_code: r.error_code ?? null,
      error_message: r.error_message ?? null,
      duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
      model: r.model ?? null,
      worker_id: r.worker_id ?? null,
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
    const rows = await db.message_edits.findMany({
      where: { message_id: messageId },
      orderBy: { edited_at: "desc" },
      take: 50,
      select: { old_content: true, edited_at: true },
    });
    return rows.map((r) => ({
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
    const conditions: Prisma.messagesWhereInput[] = [{ channel_id: channelId }];

    if (query.cursor) {
      conditions.push({ created_at: { lt: BigInt(Number(query.cursor)) } });
    }

    // Exclude spam threads (NULL-safe)
    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    const rows = await db.messages.findMany({
      where: { AND: conditions },
      orderBy: { created_at: "desc" },
      take: cursorLimit(limit),
      select: messageWithVerdict,
    });

    const data = rows
      .slice(0, limit)
      .map((r) => mapMessageRow(flattenVerdict(r)));
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
    const conditions: Prisma.messagesWhereInput[] = [];

    if (query.guildId) {
      conditions.push({ guild_id: query.guildId });
    }
    if (query.channelId) {
      conditions.push({ channel_id: query.channelId });
    }
    if (query.userId) {
      conditions.push({ user_id: query.userId });
    }
    if (query.status) {
      conditions.push({ ai_status: query.status });
    }
    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    let cursor: string | undefined = query.cursor;

    while (true) {
      const pageConditions = [...conditions];
      if (cursor) {
        pageConditions.push({
          created_at: { lt: BigInt(Number(cursor)) },
        });
      }

      const db = getDatabase();
      const rows = await db.messages.findMany({
        where: { AND: pageConditions },
        orderBy: { created_at: "desc" },
        take: cursorLimit(pageSize),
        select: messageWithVerdict,
      });

      if (rows.length === 0) return;

      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      for (const r of pageRows) {
        yield mapMessageRow(flattenVerdict(r));
      }

      if (!hasMore) return;
      cursor = String(rows[pageSize - 1].created_at);
    }
  }

  async create(data: MessageCreate) {
    const db = getDatabase();
    const id = crypto.randomUUID();

    const row = await db.messages.create({
      data: {
        id,
        guild_id: data.guildId,
        channel_id: data.channelId,
        thread_id: data.threadId ?? null,
        user_id: data.userId,
        username: data.username,
        avatar_url: data.avatarUrl ?? null,
        content: data.content,
        edited_content: null,
        created_at: BigInt(Date.now()),
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
      },
      select: messageWithVerdict,
    });

    return mapMessageRow(flattenVerdict(row));
  }

  async update(id: string, data: MessageUpdate) {
    const db = getDatabase();

    const setData: Prisma.messagesUpdateInput = {};

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
    if (data.aiConfidence !== undefined) {
      setData.ai_confidence = data.aiConfidence;
    }

    if (Object.keys(setData).length === 0) return this.findById(id);

    const row = await db.messages.update({
      where: { id },
      data: setData,
      select: messageWithVerdict,
    });

    if (!row) return null;
    return mapMessageRow(flattenVerdict(row));
  }

  /**
   * Messages a human should look at: verdict `deleted` — the model decided the
   * message should be removed — plus any that ran out of attempts (`dead`).
   *
   * This used to be `messages.ai_status IN ('warn','flagged')`, which returned
   * an empty list forever once the new worker started writing only `analyzed` to
   * that column. The judgement lives in `verdicts.status` now. Of the statuses
   * that survived the collapse, `deleted` is the only one that means "a human
   * must decide": `clean` is a pass, and `error` is a failed analysis attempt,
   * which the `dead` retry path already covers.
   *
   * CURSOR PAGINATION MUST MATCH THE ORDER BY
   *
   * This query does not sort by recency — it sorts actionable-first, then by how
   * hard the model judged the message, then newest, which is the order a
   * moderator works the queue in. A `created_at`-only cursor would therefore be
   * wrong here: every page re-sorts independently, so the same row reappears on
   * page 2 while rows from page 1 that fell below the cut are silently lost.
   *
   * So the cursor carries the WHOLE sort key (action rank, score, created_at,
   * id) and the WHERE clause replays it as a nested lexicographic comparison
   * against the same key expressions the ORDER BY uses. Both sides read
   * `reviewActionRank()` / `reviewScoreKey()` — one definition each — so the
   * comparison cannot drift from the sort. `id` is the final tiebreak in the
   * ORDER BY precisely so that a cursor has a total order to resume from: two
   * rows sharing (action, score, created_at) would otherwise be returned in
   * an arbitrary order and could be duplicated or skipped across pages.
   */
  async getReviewMessages(
    channelId?: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<ReviewPageResult> {
    const db = getDatabase();
    const conditions: Prisma.messagesWhereInput[] = [
      {
        OR: [
          { verdicts: { is: { status: "deleted" } } },
          { ai_status: "dead" },
        ],
      },
    ];

    if (channelId) {
      conditions.push({ channel_id: channelId });
    }

    const excludeThreads = excludeSpamThreads();
    if (excludeThreads) conditions.push(excludeThreads);

    // The sort key is a computed expression (CASE rank, FLOOR(score*100)), and
    // Prisma's `orderBy` accepts only a column, so the queue is ordered in JS
    // via `compareReviewOrder`. Two consequences, both handled here:
    //
    //   * The cursor comparison was ALSO a computed expression in SQL, so it
    //     moves into the same JS filter. `compareReviewOrder(a, at) > 0` is the
    //     exact inverse of the sort, which is what keeps page 2 from
    //     re-emitting page 1's rows.
    //   * `take` can no longer bound the scan, since the ordering happens after
    //     the fetch. Rows are therefore over-fetched and trimmed below. The
    //     window is bounded by `REVIEW_SCAN_FACTOR * limit` to keep the fetch
    //     proportional to the page.
    const at = decodeReviewCursor(cursor);

    const rows = await db.messages.findMany({
      where: { AND: conditions },
      take: Math.max(cursorLimit(limit) * REVIEW_SCAN_FACTOR, REVIEW_MIN_SCAN),
      select: reviewSelect,
    });

    const keyed = rows.map((r) => ({
      row: r,
      key: {
        id: r.id,
        created_at: r.created_at,
        action: actionRankOf(r.verdicts?.status ?? null),
        score: scoreRankOf(r.verdicts?.score ?? null),
      } satisfies ReviewSortKey,
    }));

    const ordered = keyed
      .filter((k) => (at ? compareReviewOrder(k.key, at) > 0 : true))
      .sort((a, b) => compareReviewOrder(a.key, b.key));

    const page = ordered.slice(0, cursorLimit(limit));
    const results = page.slice(0, limit).map((k) => flattenVerdict(k.row));

    // Cursor comes from the LAST RETURNED row (index `limit - 1`), not the
    // overflow row at index `limit` — see `nextCursorAt` for why that
    // distinction costs a row per page boundary if you get it backwards.
    const overflowed = page.length > limit;
    const last = overflowed ? page[limit - 1].key : null;
    const nextCursor =
      last && results.length === limit
        ? encodeReviewCursor({
            action: last.action,
            score: last.score,
            created_at: Number(last.created_at),
            id: last.id,
          })
        : null;

    return { results, nextCursor };
  }

  async delete(id: string): Promise<boolean> {
    const db = getDatabase();
    const result = await db.messages.deleteMany({ where: { id } });

    return result.count > 0;
  }

  async getImageMessages(
    guildId: string,
    limit: number = 50,
  ): Promise<PageResult<MessageRow>> {
    const db = getDatabase();

    // Subquery: find distinct message_ids from attachments with image MIME type
    const attachmentConditions: Prisma.attachmentsWhereInput[] = [
      { guild_id: guildId },
      { type: { startsWith: "image/" } },
    ];
    // Exclude spam threads (NULL-safe for non-thread messages)
    const excludeAttachments =
      EXCLUDED_THREAD_IDS.length > 0
        ? {
            OR: [
              { thread_id: null },
              { thread_id: { notIn: EXCLUDED_THREAD_IDS } },
            ],
          }
        : undefined;
    if (excludeAttachments) attachmentConditions.push(excludeAttachments);

    // Over-fetched relative to `limit` because a message can carry several image
    // attachments: the previous `IN (SELECT ... LIMIT limit+1)` capped the
    // candidate *attachments*, so duplicates within that window collapsed and
    // the page came back short. Deduplicating first is what the subquery did
    // not do, and `cursorLimit` here is measured in distinct messages.
    const imageAttachments = await db.attachments.findMany({
      where: { AND: attachmentConditions },
      orderBy: { created_at: "desc" },
      take: cursorLimit(limit) * ATTACHMENT_ID_OVERSAMPLE,
      select: { message_id: true },
    });
    const imageMsgIds = [...new Set(imageAttachments.map((a) => a.message_id))];

    // Fetch full message rows for those IDs
    const rows = imageMsgIds.length
      ? await db.messages.findMany({
          where: { id: { in: imageMsgIds } },
          orderBy: { created_at: "desc" },
          take: cursorLimit(limit),
          select: messageWithVerdict,
        })
      : [];

    const data = rows
      .slice(0, limit)
      .map((r) => mapMessageRow(flattenVerdict(r)));
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
    const conditions: Prisma.attachmentsWhereInput[] = [
      { channel_id: channelId },
    ];

    // Detail view: narrow to the selected message so we don't show
    // everyone else's images from the same channel.
    if (query.messageId) {
      conditions.push({ message_id: query.messageId });
    }

    if (query.cursor) {
      conditions.push({
        created_at: { lt: BigInt(Number(query.cursor)) },
      });
    }

    const rows = await db.attachments.findMany({
      where: { AND: conditions },
      orderBy: { created_at: "desc" },
      take: cursorLimit(limit),
    });

    const data = rows.map(mapAttachmentRow);

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
    const since = BigInt(Date.now() - days * 24 * 60 * 60 * 1000);

    // `EXTRACT(HOUR FROM to_timestamp(created_at / 1000))` resolved in the
    // database's timezone — see `localHour` for why UTC would be wrong here.
    const rows = await db.messages.findMany({
      where: { created_at: { gte: since } },
      select: { channel_id: true, metadata: true, created_at: true },
    });

    const buckets = new Map<string, { channelName: string; hours: number[] }>();
    for (const r of rows) {
      const channelName = readChannelName(r.metadata) ?? r.channel_id;
      const hour = localHour(r.created_at);
      const entry = buckets.get(r.channel_id) ?? {
        channelName,
        hours: new Array(24).fill(0),
      };
      // A later row may carry the name when an earlier one did not.
      if (entry.channelName === r.channel_id && channelName !== r.channel_id) {
        entry.channelName = channelName;
      }
      entry.hours[hour] += 1;
      buckets.set(r.channel_id, entry);
    }

    return [...buckets.entries()]
      .flatMap(([channelId, v]) =>
        v.hours.map((count, hour) => ({
          channelId: channelId || "unknown",
          channelName: v.channelName || "unknown",
          hour,
          count,
        })),
      )
      .sort(
        (a, b) => a.channelName.localeCompare(b.channelName) || a.hour - b.hour,
      );
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

    const at = decodeEditCursor(cursor);

    // `message_edits.message_id` has no foreign key and so no Prisma relation,
    // so the previous INNER JOIN to `messages` becomes a keyed lookup. Ordering
    // is on `message_edits` columns alone, so the fetch needs no over-scan.
    // `message_edits` has no channel column and no foreign key, so a
    // channelId filter has to be resolved to message ids first. That lookup is
    // skipped when no channel was requested, which is the common case.
    let channelMessageIds: string[] | null = null;
    if (channelId) {
      const inChannel = await db.messages.findMany({
        where: { channel_id: channelId },
        select: { id: true },
      });
      channelMessageIds = inChannel.map((m) => m.id);
      if (channelMessageIds.length === 0) {
        return { results: [], nextCursor: null };
      }
    }

    const rows = await db.message_edits.findMany({
      where: {
        AND: [
          at
            ? {
                OR: [
                  { edited_at: { lt: BigInt(at.edited_at) } },
                  {
                    AND: [
                      { edited_at: BigInt(at.edited_at) },
                      { id: { lt: at.id } },
                    ],
                  },
                ],
              }
            : {},
          ...(channelMessageIds
            ? [{ message_id: { in: channelMessageIds } }]
            : []),
        ].filter((c) => Object.keys(c).length > 0),
      },
      orderBy: [{ edited_at: "desc" }, { id: "desc" }],
      take: cursorLimit(limit),
      select: {
        id: true,
        message_id: true,
        old_content: true,
        edited_at: true,
      },
    });

    const messageIds = [...new Set(rows.map((r) => r.message_id))];
    const contextById = new Map<
      string,
      {
        channel_id: string;
        channel_name: string;
        username: string;
        new_content: string;
      }
    >();
    if (messageIds.length > 0) {
      const msgs = await db.messages.findMany({
        where: { id: { in: messageIds } },
        select: {
          id: true,
          channel_id: true,
          metadata: true,
          username: true,
          content: true,
          edited_content: true,
        },
      });
      for (const m of msgs) {
        // An INNER JOIN dropped edits whose message is gone; `contextById`
        // reproduces that by filtering below rather than emitting a null row.
        contextById.set(m.id, {
          channel_id: m.channel_id,
          channel_name: readChannelName(m.metadata) ?? m.channel_id,
          username: m.username,
          new_content: m.edited_content ?? m.content,
        });
      }
    }

    // The `limit + 1`-th row is fetched purely to detect "there is more"; it is
    // not part of `results`. The cursor is built from the last RETURNED row
    // (index `limit - 1`) — see `nextCursorAt` for why index `limit` loses a
    // row per page boundary.
    const joined = rows
      .slice(0, limit)
      .map((r) => {
        const ctx = contextById.get(r.message_id);
        if (!ctx) return null;
        return {
          id: String(r.id),
          message_id: String(r.message_id),
          old_content: r.old_content ? String(r.old_content) : "",
          new_content: ctx.new_content ? String(ctx.new_content) : "",
          edited_at: r.edited_at ? Number(r.edited_at) : 0,
          channel_id: ctx.channel_id ? String(ctx.channel_id) : null,
          channel_name: ctx.channel_name ? String(ctx.channel_name) : null,
          username: ctx.username ? String(ctx.username) : null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const last = rows.length > limit ? rows[limit - 1] : undefined;
    const nextCursor = last
      ? encodeEditCursor({
          edited_at: Number(last.edited_at ?? 0),
          id: String(last.id),
        })
      : null;

    return { results: joined, nextCursor };
  }

  /**
   * Distinct guilds present in the message archive (drives the guild picker).
   */
  async listGuilds(): Promise<
    Array<{ id: string; name: string; icon: string | null }>
  > {
    const db = getDatabase();
    const rows = await db.messages.findMany({
      distinct: ["guild_id"],
      orderBy: { guild_id: "asc" },
      select: { guild_id: true },
    });
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
    const rows = await db.messages.findMany({
      where: { guild_id: guildId },
      distinct: ["channel_id"],
      orderBy: { channel_id: "asc" },
      select: { channel_id: true },
    });
    return rows.map((row) => ({
      id: String(row.channel_id ?? ""),
      name: `Channel ${String(row.channel_id).slice(0, 8)}`,
      type: "text" as const,
    }));
  }
}

export const messagesRepository = new MessagesRepository();
