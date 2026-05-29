import { and, asc, desc, eq, gte, isNull, or, type SQL } from "drizzle-orm";
import { getDatabase } from "../database/drizzle.js";
import { messagesTable } from "../database/schema.js";
import { createChildLogger } from "../logger.js";
import type { MessageRecord } from "./types.js";

const logger = createChildLogger("analytics-store");

// ── DB helper ──────────────────────────────────────────────────────────
function db() {
  return getDatabase() as {
    select(fields?: Record<string, unknown>): {
      from(table: unknown): {
        where(cond: SQL | undefined): {
          orderBy(...cols: unknown[]): {
            limit(n: number): Promise<unknown[]>;
          } & Promise<unknown[]>;
          groupBy(...cols: unknown[]): Promise<unknown[]>;
        } & Promise<unknown[]>;
        limit(n: number): Promise<unknown[]>;
      } & Promise<unknown[]>;
    };
  };
}

// ── Shared condition helper ────────────────────────────────────────────
function channelFilter(channelId: string): SQL {
  return or(
    eq(messagesTable.channel_id, channelId),
    eq(messagesTable.thread_id, channelId),
  ) as SQL;
}

// ── Types ──────────────────────────────────────────────────────────────

export interface HourlyBucket {
  hour: string;
  count: number;
  clean: number;
  warned: number;
  flagged: number;
  error: number;
}

export interface TopicTrend {
  topic: string;
  count: number;
  score: number;
}

export interface UserStat {
  user_id: string;
  username: string;
  avatar_url: string | null;
  message_count: number;
  edited_count: number;
  deleted_count: number;
  flagged_count: number;
  last_active: number;
}

export interface ModerationBreakdown {
  total: number;
  clean: number;
  warned: number;
  flagged: number;
  error: number;
  pending: number;
  average_score: number;
}

export interface AnalyticsOverview {
  period: { start: number; end: number };
  messages: ModerationBreakdown;
  hourly: HourlyBucket[];
  topics: TopicTrend[];
  top_users: UserStat[];
  active_users_count: number;
  total_channels: number;
}

// ── Hourly Message Stats ───────────────────────────────────────────────

export async function getHourlyStats(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<HourlyBucket[]> {
  try {
    const { guildId, channelId, hours = 24 } = input;
    const since = Date.now() - hours * 3600_000;
    const database = db();

    const conditions: SQL[] = [
      eq(messagesTable.guild_id, guildId),
      gte(messagesTable.created_at, since),
      isNull(messagesTable.deleted_at),
    ];

    if (channelId) {
      conditions.push(channelFilter(channelId));
    }

    const rows = (await database
      .select()
      .from(messagesTable)
      .where(and(...conditions) as SQL)
      .orderBy(asc(messagesTable.created_at))) as MessageRecord[];

    // Initialize all hour buckets
    const buckets = new Map<
      string,
      { count: number; clean: number; warned: number; flagged: number; error: number }
    >();

    for (let h = 0; h < hours; h++) {
      const ts = new Date(since + h * 3600_000);
      ts.setMinutes(0, 0, 0);
      const key = ts.toISOString().slice(0, 13) + ":00:00Z";
      buckets.set(key, { count: 0, clean: 0, warned: 0, flagged: 0, error: 0 });
    }

    for (const row of rows) {
      const d = new Date(row.created_at);
      d.setMinutes(0, 0, 0);
      const key = d.toISOString().slice(0, 13) + ":00:00Z";

      const bucket = buckets.get(key);
      if (!bucket) continue;

      bucket.count++;
      const status = row.ai_status || "pending";
      if (status === "clean") bucket.clean++;
      else if (status === "warn") bucket.warned++;
      else if (status === "flagged") bucket.flagged++;
      else if (status === "error") bucket.error++;
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, data]) => ({ hour, ...data }));
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get hourly stats",
    );
    return [];
  }
}

// ── Topic Trends ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "yang", "dan", "itu", "ini", "dengan", "akan", "pada", "dari", "di", "ke",
  "untuk", "tidak", "ada", "juga", "sudah", "saya", "kamu", "dia", "mereka",
  "kami", "aku", "lo", "lu", "gua", "gue", "org", "orang", "aja", "sama",
  "kalo", "kalau", "bisa", "karena", "gak", "nggak", "ga", "tak", "belum",
  "udah", "dah", "lah", "kah", "pun", "nih", "tuh", "deh", "dong", "si",
  "nya", "kan", "ya", "yah", "yuk", "kok", "loh", "nah", "wow", "eh",
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing",
  "will", "would", "could", "should", "may", "might", "must", "shall",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their",
  "and", "but", "or", "nor", "not", "so", "yet", "for", "if",
  "to", "of", "in", "on", "at", "by", "as", "with", "about",
  "just", "then", "now", "here", "there", "when", "where", "why",
  "how", "all", "both", "each", "few", "more", "most", "other",
  "some", "such", "only", "own", "same", "too", "very", "can",
  "go", "ok", "okay", "yeah", "yes", "no",
]);

function extractTopics(messages: MessageRecord[], topN = 15): TopicTrend[] {
  const topicScores = new Map<string, { count: number; score: number }>();
  const wordFreq = new Map<string, number>();
  const flaggedWordFreq = new Map<string, number>();

  for (const msg of messages) {
    if (msg.ai_analysis) {
      try {
        const analysis = JSON.parse(msg.ai_analysis);
        const topics = analysis.topics;
        if (topics && Array.isArray(topics)) {
          for (const topic of topics) {
            const key = typeof topic === "string" ? topic : topic.name || topic.topic;
            if (!key) continue;
            const k = key.toLowerCase();
            const score = msg.ai_moderation_score || 0;
            const existing = topicScores.get(k);
            if (existing) { existing.count++; existing.score += score; }
            else { topicScores.set(k, { count: 1, score }); }
          }
        }
        if (analysis.category) {
          const cat = String(analysis.category).toLowerCase();
          const existing = topicScores.get(cat);
          if (existing) { existing.count++; existing.score += msg.ai_moderation_score || 0; }
          else { topicScores.set(cat, { count: 1, score: msg.ai_moderation_score || 0 }); }
        }
      } catch { /* not valid JSON */ }
    }

    if (msg.content) {
      const words = msg.content
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
        if (msg.ai_status === "flagged" || msg.ai_status === "warn") {
          flaggedWordFreq.set(word, (flaggedWordFreq.get(word) || 0) + 1);
        }
      }
    }
  }

  const results: TopicTrend[] = [];
  for (const [topic, data] of topicScores) {
    results.push({ topic, count: data.count, score: data.score });
  }

  const sortedWords = Array.from(wordFreq.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN);

  for (const [word, count] of sortedWords) {
    if (!topicScores.has(word)) {
      results.push({ topic: word, count, score: flaggedWordFreq.get(word) || 0 });
    }
  }

  return results.sort((a, b) => b.count - a.count).slice(0, topN);
}

export async function getTopicTrends(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<TopicTrend[]> {
  try {
    const { guildId, channelId, hours = 24 } = input;
    const since = Date.now() - hours * 3600_000;
    const database = db();

    const conditions: SQL[] = [
      eq(messagesTable.guild_id, guildId),
      gte(messagesTable.created_at, since),
      isNull(messagesTable.deleted_at),
    ];

    if (channelId) {
      conditions.push(channelFilter(channelId));
    }

    const rows = (await database
      .select()
      .from(messagesTable)
      .where(and(...conditions) as SQL)
      .orderBy(desc(messagesTable.created_at))
      .limit(1000)) as MessageRecord[];

    return extractTopics(rows);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get topic trends",
    );
    return [];
  }
}

// ── User Leaderboard ────────────────────────────────────────────────────

export async function getUserLeaderboard(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
  limit?: number;
}): Promise<UserStat[]> {
  try {
    const { guildId, channelId, hours = 24, limit = 20 } = input;
    const since = Date.now() - hours * 3600_000;
    const database = db();

    const conditions: SQL[] = [
      eq(messagesTable.guild_id, guildId),
      gte(messagesTable.created_at, since),
      isNull(messagesTable.deleted_at),
    ];

    if (channelId) {
      conditions.push(channelFilter(channelId));
    }

    const rows = (await database
      .select()
      .from(messagesTable)
      .where(and(...conditions) as SQL)
      .orderBy(asc(messagesTable.created_at))) as MessageRecord[];

    const userMap = new Map<string, UserStat>();

    for (const msg of rows) {
      const existing = userMap.get(msg.user_id);
      if (existing) {
        existing.message_count++;
        if (msg.type === "edited") existing.edited_count++;
        if (msg.type === "deleted") existing.deleted_count++;
        if (msg.ai_status === "flagged" || msg.ai_status === "warn") existing.flagged_count++;
        if (msg.created_at > existing.last_active) {
          existing.last_active = msg.created_at;
        }
      } else {
        userMap.set(msg.user_id, {
          user_id: msg.user_id,
          username: msg.username,
          avatar_url: msg.avatar_url,
          message_count: 1,
          edited_count: msg.type === "edited" ? 1 : 0,
          deleted_count: msg.type === "deleted" ? 1 : 0,
          flagged_count: msg.ai_status === "flagged" || msg.ai_status === "warn" ? 1 : 0,
          last_active: msg.created_at,
        });
      }
    }

    return Array.from(userMap.values())
      .sort((a, b) => b.message_count - a.message_count)
      .slice(0, limit);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get user leaderboard",
    );
    return [];
  }
}

// ── Moderation Stats ───────────────────────────────────────────────────

export async function getModerationStats(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<ModerationBreakdown> {
  try {
    const { guildId, channelId, hours = 24 } = input;
    const since = Date.now() - hours * 3600_000;
    const database = db();

    const conditions: SQL[] = [
      eq(messagesTable.guild_id, guildId),
      gte(messagesTable.created_at, since),
      isNull(messagesTable.deleted_at),
    ];

    if (channelId) {
      conditions.push(channelFilter(channelId));
    }

    const rows = (await database
      .select()
      .from(messagesTable)
      .where(and(...conditions) as SQL)) as MessageRecord[];

    const breakdown: ModerationBreakdown = {
      total: rows.length,
      clean: 0, warned: 0, flagged: 0, error: 0, pending: 0,
      average_score: 0,
    };

    let scoreSum = 0;
    let scoreCount = 0;

    for (const msg of rows) {
      const status = msg.ai_status || "pending";
      if (status === "clean") breakdown.clean++;
      else if (status === "warn") breakdown.warned++;
      else if (status === "flagged") breakdown.flagged++;
      else if (status === "error") breakdown.error++;
      else breakdown.pending++;

      if (msg.ai_moderation_score != null) {
        scoreSum += msg.ai_moderation_score;
        scoreCount++;
      }
    }

    breakdown.average_score =
      scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : 0;

    return breakdown;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get moderation stats",
    );
    return {
      total: 0, clean: 0, warned: 0, flagged: 0, error: 0, pending: 0, average_score: 0,
    };
  }
}

// ── Active Channels Count ──────────────────────────────────────────────

export async function getActiveChannelCount(input: {
  guildId: string;
  hours?: number;
}): Promise<number> {
  try {
    const { guildId, hours = 24 } = input;
    const since = Date.now() - hours * 3600_000;
    const database = db();

    const rows = (await database
      .select({ channel_id: messagesTable.channel_id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.guild_id, guildId),
          gte(messagesTable.created_at, since),
          isNull(messagesTable.deleted_at),
        ) as SQL,
      )
      .groupBy(messagesTable.channel_id)) as Array<{ channel_id: string }>;

    return rows.length;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get active channel count",
    );
    return 0;
  }
}

// ── Top Violators ─────────────────────────────────────────────────────

export interface ViolatorStat {
  user_id: string;
  username: string;
  avatar_url: string | null;
  total_messages: number;
  flagged_count: number;
  warned_count: number;
  violation_score: number; // weighted: flagged*3 + warned*1
  worst_flags: string[];   // unique flag types
  last_violation: number;
}

export async function getTopViolators(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
  limit?: number;
}): Promise<ViolatorStat[]> {
  try {
    const { guildId, channelId, hours = 24, limit = 20 } = input;
    const since = Date.now() - hours * 3600_000;
    const database = db();

    const conditions: SQL[] = [
      eq(messagesTable.guild_id, guildId),
      gte(messagesTable.created_at, since),
      isNull(messagesTable.deleted_at),
    ];

    if (channelId) {
      conditions.push(channelFilter(channelId));
    }

    const rows = (await database
      .select()
      .from(messagesTable)
      .where(and(...conditions) as SQL)
      .orderBy(asc(messagesTable.created_at))) as MessageRecord[];

    const userMap = new Map<string, {
      user_id: string;
      username: string;
      avatar_url: string | null;
      total_messages: number;
      flagged_count: number;
      warned_count: number;
      flags_set: Set<string>;
      last_violation: number;
    }>();

    for (const msg of rows) {
      let entry = userMap.get(msg.user_id);
      if (!entry) {
        entry = {
          user_id: msg.user_id,
          username: msg.username,
          avatar_url: msg.avatar_url,
          total_messages: 0,
          flagged_count: 0,
          warned_count: 0,
          flags_set: new Set(),
          last_violation: 0,
        };
        userMap.set(msg.user_id, entry);
      }

      entry.total_messages++;

      const isViolation = msg.ai_status === "flagged" || msg.ai_status === "warn";

      if (msg.ai_status === "flagged") {
        entry.flagged_count++;
      }

      if (msg.ai_status === "warn") {
        entry.warned_count++;
      }

      if (isViolation && msg.ai_moderation_flags) {
        try {
          const flags = JSON.parse(msg.ai_moderation_flags);
          if (Array.isArray(flags)) {
            for (const f of flags) entry.flags_set.add(String(f));
          }
        } catch { /* ignore */ }
      }

      if (isViolation && msg.created_at > entry.last_violation) {
        entry.last_violation = msg.created_at;
      }
    }

    const violators: ViolatorStat[] = [];

    for (const entry of userMap.values()) {
      if (entry.flagged_count === 0 && entry.warned_count === 0) continue;

      violators.push({
        user_id: entry.user_id,
        username: entry.username,
        avatar_url: entry.avatar_url,
        total_messages: entry.total_messages,
        flagged_count: entry.flagged_count,
        warned_count: entry.warned_count,
        violation_score: entry.flagged_count * 3 + entry.warned_count * 1,
        worst_flags: Array.from(entry.flags_set).slice(0, 5),
        last_violation: entry.last_violation,
      });
    }

    return violators
      .sort((a, b) => b.violation_score - a.violation_score)
      .slice(0, limit);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get top violators",
    );
    return [];
  }
}

// ── Combined Overview ──────────────────────────────────────────────────

export async function getAnalyticsOverview(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<AnalyticsOverview> {
  const { guildId, hours = 24 } = input;
  const now = Date.now();
  const since = now - hours * 3600_000;

  const [messages, hourly, topics, topUsers, totalChannels] = await Promise.all([
    getModerationStats(input),
    getHourlyStats(input),
    getTopicTrends(input),
    getUserLeaderboard(input),
    getActiveChannelCount({ guildId, hours }),
  ]);

  return {
    period: { start: since, end: now },
    messages,
    hourly,
    topics,
    top_users: topUsers,
    active_users_count: topUsers.length,
    total_channels: totalChannels,
  };
}
