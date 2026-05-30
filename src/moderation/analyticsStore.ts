import { getDatabase } from "../database/drizzle.js";
import { createChildLogger } from "../logger.js";
import type { MessageRecord } from "./types.js";

const logger = createChildLogger("analytics-store");

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

// ── Cache for topic trends ─────────────────────────────────────────────

interface TopicCacheEntry {
  data: TopicTrend[];
  expiresAt: number;
  key: string;
}

const topicCache = new Map<string, TopicCacheEntry>();
const TOPIC_CACHE_TTL_MS = 60_000; // 1 minute TTL

function makeTopicCacheKey(input: {
  guildId: string;
  channelId?: string;
  hours: number;
}): string {
  return `${input.guildId}:${input.channelId ?? "*"}:${input.hours}`;
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
    const rawDb = getDatabase() as any;
    const sqliteRows = rawDb.all(
      `
      SELECT
        datetime((created_at / 3600000) * 3600, 'unixepoch') as hour,
        count(*) as count,
        count(case when ai_status = 'clean' then 1 end) as clean,
        count(case when ai_status = 'warn' then 1 end) as warned,
        count(case when ai_status = 'flagged' then 1 end) as flagged,
        count(case when ai_status = 'error' then 1 end) as error
      FROM messages
      WHERE guild_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
        ${channelId ? `AND (channel_id = ? OR thread_id = ?)` : ""}
      GROUP BY (created_at / 3600000)
      ORDER BY hour ASC
      `,
      channelId
        ? [guildId, since, channelId, channelId]
        : [guildId, since],
    );

    // Initialize all hour buckets (fill gaps with zeros)
    const buckets = new Map<
      string,
      {
        count: number;
        clean: number;
        warned: number;
        flagged: number;
        error: number;
      }
    >();

    for (let h = 0; h < hours; h++) {
      const ts = new Date(since + h * 3600_000);
      ts.setMinutes(0, 0, 0);
      const key = ts.toISOString().slice(0, 13) + ":00:00Z";
      buckets.set(key, { count: 0, clean: 0, warned: 0, flagged: 0, error: 0 });
    }

    for (const row of sqliteRows) {
      // Normalize the SQL hour key to match our bucket format
      const d = new Date(row.hour.replace(" ", "T") + "Z");
      const key = d.toISOString().slice(0, 13) + ":00:00Z";

      const bucket = buckets.get(key);
      if (!bucket) continue;

      bucket.count = row.count;
      bucket.clean = row.clean;
      bucket.warned = row.warned;
      bucket.flagged = row.flagged;
      bucket.error = row.error;
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
  "yang",
  "dan",
  "itu",
  "ini",
  "dengan",
  "akan",
  "pada",
  "dari",
  "di",
  "ke",
  "untuk",
  "tidak",
  "ada",
  "juga",
  "sudah",
  "saya",
  "kamu",
  "dia",
  "mereka",
  "kami",
  "aku",
  "lo",
  "lu",
  "gua",
  "gue",
  "org",
  "orang",
  "aja",
  "sama",
  "kalo",
  "kalau",
  "bisa",
  "karena",
  "gak",
  "nggak",
  "ga",
  "tak",
  "belum",
  "udah",
  "dah",
  "lah",
  "kah",
  "pun",
  "nih",
  "tuh",
  "deh",
  "dong",
  "si",
  "nya",
  "kan",
  "ya",
  "yah",
  "yuk",
  "kok",
  "loh",
  "nah",
  "wow",
  "eh",
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
  "doing",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "for",
  "if",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "as",
  "with",
  "about",
  "just",
  "then",
  "now",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "own",
  "same",
  "too",
  "very",
  "can",
  "go",
  "ok",
  "okay",
  "yeah",
  "yes",
  "no",
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
            const key =
              typeof topic === "string" ? topic : topic.name || topic.topic;
            if (!key) continue;
            const k = key.toLowerCase();
            const score = msg.ai_moderation_score || 0;
            const existing = topicScores.get(k);
            if (existing) {
              existing.count++;
              existing.score += score;
            } else {
              topicScores.set(k, { count: 1, score });
            }
          }
        }
        if (analysis.category) {
          const cat = String(analysis.category).toLowerCase();
          const existing = topicScores.get(cat);
          if (existing) {
            existing.count++;
            existing.score += msg.ai_moderation_score || 0;
          } else {
            topicScores.set(cat, {
              count: 1,
              score: msg.ai_moderation_score || 0,
            });
          }
        }
      } catch {
        /* not valid JSON */
      }
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
      results.push({
        topic: word,
        count,
        score: flaggedWordFreq.get(word) || 0,
      });
    }
  }

  return results.sort((a, b) => b.count - a.count).slice(0, topN);
}

export async function getTopicTrends(input: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<TopicTrend[]> {
  const { guildId, channelId, hours = 24 } = input;
  const cacheKey = makeTopicCacheKey({ guildId, channelId, hours });

  // Check cache first (P2: cache topic extraction)
  const cached = topicCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const since = Date.now() - hours * 3600_000;
    const rawDb = getDatabase() as any;

    const rows = rawDb.all(
      `
      SELECT
        id, content, ai_status, ai_analysis, ai_moderation_score,
        ai_moderation_flags, created_at
      FROM messages
      WHERE guild_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
        ${channelId ? `AND (channel_id = ? OR thread_id = ?)` : ""}
      ORDER BY created_at DESC
      LIMIT 1000
      `,
      channelId
        ? [guildId, since, channelId, channelId]
        : [guildId, since],
    ) as MessageRecord[];

    const result = extractTopics(rows);

    // Store in cache
    topicCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + TOPIC_CACHE_TTL_MS,
      key: cacheKey,
    });

    return result;
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
    const rawDb = getDatabase() as any;

    // SQL-level GROUP BY aggregate instead of SELECT * + in-memory map
    const rows = rawDb.all(
      `
      SELECT
        user_id,
        username,
        avatar_url,
        count(*) as message_count,
        count(case when type = 'edited' then 1 end) as edited_count,
        count(case when type = 'deleted' then 1 end) as deleted_count,
        count(case when ai_status in ('flagged', 'warn') then 1 end) as flagged_count,
        max(created_at) as last_active
      FROM messages
      WHERE guild_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
        ${channelId ? `AND (channel_id = ? OR thread_id = ?)` : ""}
      GROUP BY user_id
      ORDER BY message_count DESC
      LIMIT ?
      `,
      channelId
        ? [guildId, since, channelId, channelId, limit]
        : [guildId, since, limit],
    );

    return rows as UserStat[];
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
    const rawDb = getDatabase() as any;

    // SQL-level aggregate instead of SELECT * + in-memory counting
    const row = rawDb.get(
      `
      SELECT
        count(*) as total,
        count(case when ai_status = 'clean' then 1 end) as clean,
        count(case when ai_status = 'warn' then 1 end) as warned,
        count(case when ai_status = 'flagged' then 1 end) as flagged,
        count(case when ai_status = 'error' then 1 end) as error,
        count(case when ai_status = 'pending' or ai_status IS NULL then 1 end) as pending,
        round(avg(ai_moderation_score), 2) as average_score
      FROM messages
      WHERE guild_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
        ${channelId ? `AND (channel_id = ? OR thread_id = ?)` : ""}
      `,
      channelId
        ? [guildId, since, channelId, channelId]
        : [guildId, since],
    );

    if (!row) {
      return {
        total: 0,
        clean: 0,
        warned: 0,
        flagged: 0,
        error: 0,
        pending: 0,
        average_score: 0,
      };
    }

    return {
      total: row.total ?? 0,
      clean: row.clean ?? 0,
      warned: row.warned ?? 0,
      flagged: row.flagged ?? 0,
      error: row.error ?? 0,
      pending: row.pending ?? 0,
      average_score: row.average_score ?? 0,
    };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get moderation stats",
    );
    return {
      total: 0,
      clean: 0,
      warned: 0,
      flagged: 0,
      error: 0,
      pending: 0,
      average_score: 0,
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
    const rawDb = getDatabase() as any;

    const row = rawDb.get(
      `
      SELECT count(DISTINCT channel_id) as cnt
      FROM messages
      WHERE guild_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
      `,
      [guildId, since],
    );

    return row?.cnt ?? 0;
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
  worst_flags: string[]; // unique flag types
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
    const rawDb = getDatabase() as any;

    // SQL-level GROUP BY aggregate for base stats
    const rows = rawDb.all(
      `
      SELECT
        user_id,
        username,
        avatar_url,
        count(*) as total_messages,
        count(case when ai_status = 'flagged' then 1 end) as flagged_count,
        count(case when ai_status = 'warn' then 1 end) as warned_count,
        max(case when ai_status in ('flagged', 'warn') then created_at else 0 end) as last_violation
      FROM messages
      WHERE guild_id = ?
        AND created_at >= ?
        AND deleted_at IS NULL
        ${channelId ? `AND (channel_id = ? OR thread_id = ?)` : ""}
      GROUP BY user_id
      HAVING flagged_count > 0 OR warned_count > 0
      ORDER BY (flagged_count * 3 + warned_count) DESC
      LIMIT ?
      `,
      channelId
        ? [guildId, since, channelId, channelId, limit]
        : [guildId, since, limit],
    );

    const violators: ViolatorStat[] = rows.map((row: any) => ({
      user_id: row.user_id,
      username: row.username,
      avatar_url: row.avatar_url,
      total_messages: row.total_messages,
      flagged_count: row.flagged_count,
      warned_count: row.warned_count,
      violation_score: row.flagged_count * 3 + row.warned_count,
      worst_flags: [], // flags require parsing JSON per-row; skip for perf
      last_violation: row.last_violation,
    }));

    return violators;
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

  const [messages, hourly, topics, topUsers, totalChannels] = await Promise.all(
    [
      getModerationStats(input),
      getHourlyStats(input),
      getTopicTrends(input),
      getUserLeaderboard(input),
      getActiveChannelCount({ guildId, hours }),
    ],
  );

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
