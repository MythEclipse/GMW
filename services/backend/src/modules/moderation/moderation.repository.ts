import { sql } from "drizzle-orm";
import { getDatabase } from "../../shared/database/index.js";

export interface ListModerationQuery {
  status?: string;
  actionType?: string;
  limit?: number;
  cursor?: number;
}

const ACTION_TYPES = ["delete_message", "reset_nickname"] as const;
const STATUSES = ["pending", "executed", "failed"] as const;

/**
 * Normalize `moderation_actions.categories` to a `text[]`, cast-free.
 *
 * The column is `text` and has been written in at least two different shapes:
 *
 *   1. `["gambling","scam"]`  — a JSON array (the current writer)
 *   2. `harassment`            — a bare category, or a comma list like
 *      `inappropriate_content, spam` (the older writer)
 *
 * 172 of 1403 live rows are shape 2. Every `::jsonb` cast on this column
 * therefore aborts the whole query, not just the offending row, which is why
 * `moderation/trends` and `moderation/byCategory` returned 500 rather than
 * skipping the bad row.
 *
 * This expression is deliberately built from `regexp_matches` and
 * `regexp_split_to_array` — pure text functions. There is no cast anywhere, so
 * no input, however malformed, can raise "invalid input syntax for type json".
 * Verified against every distinct live value, plus adversarial junk
 * (`{"not":"an array"}`, `[unclosed`, `null`, `a, b, , c`): all resolve to a
 * plain array instead of throwing.
 *
 *   - Quoted tokens are preferred, so a JSON-array row yields its members
 *     rather than the whole `["a","b"]` string.
 *   - Otherwise the raw value is split on commas.
 *   - An empty/blank cell yields NULL (no categories), never `['']`.
 */
const CATEGORIES_TXT_ARRAY = `COALESCE(
  (SELECT array_agg(DISTINCT t[1])
     FROM regexp_matches(COALESCE(a.categories,''), '"([^"]*)"', 'g') AS t),
  NULLIF(regexp_split_to_array(btrim(a.categories), '\\s*,\\s*'), ARRAY[''])
)`;

/** Parse a JSON-stringified array column (e.g. flags/categories/evidence).
 *  Returns null on empty/malformed input so the FE can treat it as "no data". */
function parseJsonArray(value: unknown): string[] | null {
  if (value == null) return null;
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0) return null;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

export class ModerationRepository {
  /**
   * Headline moderation counts.
   *
   * This used to aggregate `moderation_actions`, the gateway's auto-delete log.
   * The rewrite removed gateway-side enforcement — deletion and DMs are now the
   * backend's job — so nothing writes that table any more and it is frozen at
   * the moment of the cutover. Counting it produced a dashboard that looked
   * static while moderation was in fact working.
   *
   * The live signal is `verdicts` (what the model decided) joined to `messages`
   * (where each message sits in the pipeline). `executed`/`failed` are kept in
   * the response so the frontend contract does not change, but they now mean
   * "actionable vs errored verdict" rather than "action succeeded".
   */
  async getStats() {
    const db = getDatabase();
    // Grouped by `status` alone. This used to also group by
    // `v.recommended_action`, but that was a second copy of the same decision:
    // it could only be 'clean' or 'deleted', so every group was already
    // determined by the status sitting beside it, and a disagreement between
    // them would only have split one verdict across two buckets. `status` is
    // the decision; `reason` is the explanation and does not belong in a count.
    const result = await db.execute(sql`
      SELECT
        COALESCE(v.status, 'unjudged') AS status,
        COUNT(*)::int AS c
      FROM messages m
      LEFT JOIN verdicts v ON v.message_id = m.id
      GROUP BY 1
    `);

    const rows = (result.rows as Record<string, unknown>[]) || [];
    let executed = 0; // verdicts that call for action
    let failed = 0; // errored verdicts
    let pending = 0; // nothing concluded yet

    const byStatus: Record<string, number> = {};

    for (const r of rows) {
      const status = String(r.status ?? "unjudged");
      const count = Number(r.c ?? 0);
      byStatus[status] = (byStatus[status] ?? 0) + count;

      if (status === "error") {
        failed += count;
      } else if (status === "unjudged") {
        pending += count;
      } else {
        executed += count;
      }
    }

    const total = executed + failed + pending;

    return {
      total,
      executed,
      failed,
      pending,
      failed_rate: total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0,
      by_status: byStatus,
    };
  }

  /**
   * Queue health from `messages` alone: how much work is outstanding, and how
   * much of it has been abandoned. `dead` is the only number here that needs a
   * human — everything else resolves on its own.
   */
  async getQueueStats() {
    const db = getDatabase();
    const result = await db.execute(sql`
      SELECT ai_status, COUNT(*)::int AS c
      FROM messages
      WHERE ai_status <> 'analyzed'
         OR deleted_at IS NOT NULL
      GROUP BY ai_status
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[String(r.ai_status)] = Number(r.c ?? 0);
    return {
      by_status: byStatus,
      pending: byStatus.pending ?? 0,
      claimed: byStatus.claimed ?? 0,
      retry_wait: byStatus.retry_wait ?? 0,
      dead: byStatus.dead ?? 0,
      // Terminal like `analyzed`, so it stays out of every "outstanding
      // work" number above. Reported on its own so an operator can see that
      // the skip list is actually taking effect.
      skipped: byStatus.skipped ?? 0,
    };
  }

  async listActions(query: ListModerationQuery) {
    const db = getDatabase();
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const conditions: string[] = [];

    if (
      query.status &&
      (STATUSES as readonly string[]).includes(query.status)
    ) {
      conditions.push(`a.status = '${query.status}'`);
    }
    if (
      query.actionType &&
      (ACTION_TYPES as readonly string[]).includes(query.actionType)
    ) {
      conditions.push(`a.action_type = '${query.actionType}'`);
    }
    if (query.cursor) {
      conditions.push(`a.created_at < ${Number(query.cursor)}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await db.execute(
      sql.raw(`
      SELECT
        a.id,
        a.message_id,
        a.user_id,
        a.guild_id,
        a.action_type,
        a.reason,
        a.executed_by,
        a.status,
        a.error,
        a.created_at,
        a.executed_at,
        a.flags,
        a.categories,
        a.confidence,
        a.score,
        a.evidence,
        a.policy_version,
        a.username,
        a.server_nick,
        LEFT(m.content, 300) AS content
      FROM moderation_actions a
      LEFT JOIN messages m ON m.id = a.message_id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ${limit + 1}
    `),
    );

    const rows = (result.rows as Record<string, unknown>[]) || [];
    const data = rows.slice(0, limit).map((r) => ({
      id: String(r.id ?? ""),
      message_id: r.message_id ? String(r.message_id) : null,
      user_id: r.user_id ? String(r.user_id) : null,
      guild_id: String(r.guild_id ?? ""),
      action_type: String(r.action_type ?? "unknown"),
      reason: r.reason ? String(r.reason) : null,
      executed_by: r.executed_by ? String(r.executed_by) : null,
      status: String(r.status ?? "unknown"),
      error: r.error ? String(r.error) : null,
      created_at: r.created_at ? Number(r.created_at) : null,
      executed_at: r.executed_at ? Number(r.executed_at) : null,
      flags: parseJsonArray(r.flags),
      categories: parseJsonArray(r.categories),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      score: r.score != null ? Number(r.score) : null,
      evidence: parseJsonArray(r.evidence),
      policy_version: r.policy_version ? String(r.policy_version) : null,
      username: r.username ? String(r.username) : null,
      server_nick: r.server_nick ? String(r.server_nick) : null,
      content: r.content ? String(r.content) : null,
    }));

    const lastRow = rows[limit - 1] as Record<string, unknown> | undefined;
    const nextCursor =
      rows.length > limit ? String(lastRow?.created_at ?? "") : null;

    return { data, nextCursor };
  }

  /**
   * Aggregate moderation trends over the last `days` days.
   * - category counts (from the jsonb/text[] `categories` column, unnested)
   * - decision distribution (ranked: what was decided, by action_type)
   * - action_type distribution
   * Read-only; powers the public Toxic Topic Trends panel.
   *
   * This panel used to chart a `severity` distribution. Severity is gone, and
   * nothing took its place on `moderation_actions` — that table has no decision
   * column, only `action_type` (what was done) and `status` (pending/executed/
   * failed).
   *
   * It returns BOTH `decisions` and `actions`, and they are deliberately not the
   * same thing: `decisions` is `action_type` with a force-ranked CASE order
   * (delete_message > reset_nickname), because `desc()` on a text enum sorts
   * lexically and would present that as the ranking. `actions` is the plain
   * count-descending breakdown. The dashboard's ranked panel reads `actions`, so
   * neither key is dead and dropping either one empties a chart.
   *
   * There are exactly two action types. `mute_user` / `warn_user` /
   * `kick_user` / `ban_user` were aspirational labels that nothing ever wrote
   * and that prod has zero rows of; they are gone rather than left as filters
   * that could only ever return an empty table.
   */
  async getTrends(days: number) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const cats = await db.execute(sql`
      SELECT cat, COUNT(*)::int AS c
      FROM (
        SELECT unnest(${sql.raw(CATEGORIES_TXT_ARRAY)}) AS cat
        FROM moderation_actions a
        WHERE a.created_at >= ${since}
          AND a.categories IS NOT NULL AND btrim(a.categories) <> ''
      ) s
      WHERE cat IS NOT NULL AND cat <> ''
      GROUP BY cat
      ORDER BY c DESC
      LIMIT 15
    `);
    const catRows = (cats.rows as Record<string, unknown>[]) || [];

    // Ranked by the DECISION, because a bare `GROUP BY action_type` returns rows in
    // an arbitrary order that is not a ranking. `action_type` is a text enum, so
    // it needs the explicit CASE — `desc()` on it directly would sort lexically
    // ("reset_nickname" > "delete_message"), which is not the order of force
    // the action represents. Count breaks ties within a decision.
    const dec = await db.execute(sql`
      SELECT action_type, COUNT(*)::int AS c
      FROM moderation_actions
      WHERE created_at >= ${since} AND action_type IS NOT NULL
      GROUP BY action_type
      ORDER BY
        CASE action_type
          WHEN 'delete_message' THEN 1
          WHEN 'reset_nickname' THEN 0
          ELSE -1
        END DESC,
        c DESC
    `);
    const decRows = (dec.rows as Record<string, unknown>[]) || [];

    const act = await db.execute(sql`
      SELECT action_type, COUNT(*)::int AS c
      FROM moderation_actions
      WHERE created_at >= ${since}
      GROUP BY action_type
      ORDER BY c DESC
    `);
    const actRows = (act.rows as Record<string, unknown>[]) || [];

    return {
      categories: catRows.map((r) => ({
        name: String(r.cat),
        count: Number(r.c ?? 0),
      })),
      decisions: decRows.map((r) => ({
        level: String(r.action_type),
        count: Number(r.c ?? 0),
      })),
      actions: actRows.map((r) => ({
        type: String(r.action_type),
        count: Number(r.c ?? 0),
      })),
    };
  }

  /**
   * Top flagged domains over the last `days` days.
   * Extracts the host from any URL in the message content / reason / evidence
   * and ranks by how often it appears in moderation actions.
   *
   * `moderation_actions` has no `content` column — the message body only lives
   * on `messages`, so the text is read through the same
   * `LEFT JOIN messages` that `listActions` and `getByCategory` use. Querying
   * `a.content` directly raised "column a.content does not exist", i.e. a 500
   * on every call.
   */
  async getTopFlaggedDomains(days: number) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await db.execute(sql`
      SELECT host, COUNT(*)::int AS c
      FROM (
        SELECT DISTINCT a.id,
          (regexp_matches(COALESCE(m.content,'') || ' ' || COALESCE(a.reason,'') || ' ' || COALESCE(a.evidence,''), 'https?://([^/\\s?#]+)', 'g'))[1] AS host
        FROM moderation_actions a
        LEFT JOIN messages m ON m.id = a.message_id
        WHERE a.created_at >= ${since}
          AND (m.content IS NOT NULL OR a.reason IS NOT NULL OR a.evidence IS NOT NULL)
      ) sub
      WHERE host IS NOT NULL
      GROUP BY host
      ORDER BY c DESC
      LIMIT 20
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];
    return rows.map((r) => ({
      domain: String(r.host).toLowerCase(),
      count: Number(r.c ?? 0),
    }));
  }

  /**
   * Top flagged channels over the last `days` days.
   * Joins moderation_actions → messages to attribute each action to a channel.
   * Powers the Top Flagged Channels panel.
   */
  async getTopFlaggedChannels(days: number) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await db.execute(sql`
      SELECT
        m.channel_id,
        COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''), m.channel_id) AS channel_name,
        COUNT(*)::int AS flagged_count
      FROM moderation_actions a
      LEFT JOIN messages m ON m.id = a.message_id
      WHERE a.created_at >= ${since} AND m.channel_id IS NOT NULL
      GROUP BY m.channel_id, (m.metadata::jsonb -> 'channel' ->> 'channelName')
      ORDER BY flagged_count DESC
      LIMIT 15
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];
    return rows.map((r) => ({
      channel_id: String(r.channel_id),
      channel_name: r.channel_name ? String(r.channel_name) : null,
      flagged_count: Number(r.flagged_count),
    }));
  }

  /**
   * Hour-of-day distribution of moderation actions over the last `days` days.
   * 24 rows (hour 0..23), with a total count per hour.
   * Powers the Moderation Heatmap by Hour panel.
   */
  async getHourlyModeration(days: number) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await db.execute(sql`
      SELECT
        EXTRACT(HOUR FROM to_timestamp(created_at / 1000))::int AS hour,
        COUNT(*)::int AS total
      FROM moderation_actions
      WHERE created_at >= ${since}
      GROUP BY hour
      ORDER BY hour
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];
    const byHour = new Map<number, number>();
    for (const r of rows) byHour.set(Number(r.hour), Number(r.total));
    return Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      total: byHour.get(h) ?? 0,
    }));
  }

  /**
   * Moderation actions filtered to a single category (drill-down).
   * Powers the Flag Category Drill-down panel.
   *
   * Uses the cast-free `CATEGORIES_TXT_ARRAY` normalizer, so a category that
   * was written as a bare string (`harassment`) is matched just like one
   * written as a JSON array (`["harassment"]`). Previously the
   * `categories::jsonb` containment test made this procedure 500 for the whole
   * table as soon as ANY row used the bare shape.
   */
  async getByCategory(days: number, category: string, limit = 50) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await db.execute(
      sql`
        SELECT
          a.id, a.message_id, a.user_id, a.guild_id, a.action_type,
          a.reason, a.status, a.created_at, a.confidence, a.score,
          a.username, LEFT(m.content, 300) AS content
        FROM moderation_actions a
        LEFT JOIN messages m ON m.id = a.message_id
        WHERE a.created_at >= ${since}
          AND a.categories IS NOT NULL
          AND btrim(a.categories) <> ''
          AND ${sql.raw(CATEGORIES_TXT_ARRAY)} @> ARRAY[${category}]::text[]
        ORDER BY a.created_at DESC
        LIMIT ${limit}
      `,
    );
    const rows = (result.rows as Record<string, unknown>[]) || [];
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      message_id: r.message_id ? String(r.message_id) : null,
      user_id: r.user_id ? String(r.user_id) : null,
      guild_id: String(r.guild_id ?? ""),
      action_type: String(r.action_type ?? "unknown"),
      reason: r.reason ? String(r.reason) : null,
      status: String(r.status ?? "unknown"),
      created_at: r.created_at ? Number(r.created_at) : null,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      score: r.score != null ? Number(r.score) : null,
      username: r.username ? String(r.username) : null,
      server_nick: r.server_nick ? String(r.server_nick) : null,
      content: r.content ? String(r.content) : null,
    }));
  }

  /**
   * Auto-moderation coverage over the last `days` days.
   * Attempt success rate from `analysis_attempts` — what fraction of model
   * calls produced a usable verdict. Public "how much is automated" trust
   * metric.
   *
   * This read `ai_analysis_runs`, which the rewrite dropped: it was written by
   * the old in-process pipeline and has been permanently empty since, so the
   * dashboard showed 0% coverage while the worker was in fact running fine.
   * `analysis_attempts` is append-only and records every attempt — successful
   * or not — which makes it the honest denominator.
   */
  async getCoverage(days: number) {
    const db = getDatabase();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await db.execute(sql`
      SELECT outcome, COUNT(*)::int AS c
      FROM analysis_attempts
      WHERE created_at >= ${since}
      GROUP BY outcome
    `);
    const rows = (result.rows as Record<string, unknown>[]) || [];
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const s = String(r.outcome);
      const c = Number(r.c ?? 0);
      counts[s] = c;
      total += c;
    }
    // "Failed" is anything the worker could not turn into a verdict. `duplicate`
    // is not a failure — the model answered fine, we just discarded a stale
    // result — so it counts as a success here.
    const completed = (counts.success ?? 0) + (counts.duplicate ?? 0);
    const failed =
      (counts.llm_error ?? 0) +
      (counts.parse_error ?? 0) +
      (counts.abandoned ?? 0);
    // Work still owed: claimed by a worker, or waiting out a retry backoff.
    const queue = await db.execute(sql`
      SELECT COUNT(*)::int AS c
      FROM messages
      WHERE ai_status IN ('pending', 'claimed', 'retry_wait')
        AND created_at >= ${since}
    `);
    const queueRows = (queue.rows as Record<string, unknown>[]) || [];
    const pending = Number(queueRows[0]?.c ?? 0);
    return {
      total,
      completed,
      failed,
      pending,
      // Counts are also exposed per-outcome so the UI can break down
      // parse failures separately from model timeouts.
      outcomes: counts,
      coverage_rate:
        total > 0 ? Number(((completed / total) * 100).toFixed(1)) : 0,
      failed_rate: total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0,
    };
  }
}

export const moderationRepository = new ModerationRepository();
