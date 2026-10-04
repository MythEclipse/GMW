import { createChildLogger } from "@/shared/logger/index";
import { getDatabase } from "../../shared/database/index.js";

/**
 * Executor for the chatbot's server-watcher tools. The tool *definitions*
 * live in chatbot.toolDefs.ts (no DB import); this file implements each one
 * against the real database.
 *
 * Every query goes through the Prisma query builder with bound parameters, so
 * model-supplied arguments cannot inject SQL.
 */

export type ToolResult = string;

const logger = createChildLogger("chatbot.tools");

/** Saturating counter of chatbot tool execution errors (for observability). */
export let toolErrors = 0;
const TOOL_ERROR_CAP = 1000;

function toolExecError(err: unknown, name: string): string {
  if (toolErrors < TOOL_ERROR_CAP) toolErrors++;
  const detail = (err as Error)?.message ?? "unknown";
  logger.warn({ tool: name, error: detail }, "Chatbot tool execution failed");
  return `Tool ${name} gagal: ${detail}`;
}

/** Executes a tool call against the real DB and returns a readable result. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const guildId =
    typeof args.guildId === "string" && args.guildId ? args.guildId : undefined;
  const channelId =
    typeof args.channelId === "string" && args.channelId
      ? args.channelId
      : undefined;
  const userId =
    typeof args.userId === "string" && args.userId ? args.userId : undefined;
  const limitRaw =
    typeof args.limit === "number" ? args.limit : Number(args.limit) || 5;
  const limit = Math.min(Math.max(1, Math.round(limitRaw)), 20);

  try {
    switch (name) {
      case "get_server_stats":
        return await serverStats(guildId, channelId);
      case "get_top_channels":
        return await topChannels(guildId, limit);
      case "get_recent_activity":
        return await recentActivity(guildId, channelId, limit);
      case "get_top_flagged":
        return await topFlagged(guildId, channelId, limit);
      case "search_messages":
        return await searchMessages(
          String(args.query ?? ""),
          guildId,
          channelId,
          limit,
        );
      case "get_user_messages":
        return await userMessages(userId, guildId, channelId, limit);
      case "get_user_profile":
        return await userProfile(userId, guildId);
      case "get_user_reputation":
        return await userReputation(userId, guildId);
      case "get_channel_culture":
        return await channelCulture(
          typeof args.channelId === "string" ? args.channelId : undefined,
        );
      case "get_message_detail":
        return await messageDetail(
          typeof args.messageId === "string" ? args.messageId : undefined,
        );
      case "get_message_reviews":
        return await messageReviews(
          guildId,
          typeof args.status === "string" ? args.status : undefined,
          limit,
        );
      case "get_voice_recordings":
        return await voiceRecordings(userId, channelId, guildId, limit);
      case "get_moderation_timeline":
        return await moderationTimeline(
          guildId,
          channelId,
          typeof args.days === "number"
            ? Math.min(Math.max(1, args.days), 60)
            : 14,
        );
      case "get_corrections":
        return await corrections(guildId, limit);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    // Best-effort: if a tool fails, return readable error instead of crashing
    return toolExecError(error, name);
  }
}

// ── Query helpers ──────────────────────────────────────────

function scopeMessages(guildId?: string, channelId?: string) {
  return {
    ...(guildId ? { guild_id: guildId } : {}),
    ...(channelId ? { channel_id: channelId } : {}),
  };
}

// ── Tool executors ──────────────────────────────────────────

async function serverStats(
  guildId?: string,
  channelId?: string,
): Promise<string> {
  const db = getDatabase();
  const where = scopeMessages(guildId, channelId);

  const [total, active, flagged, clean] = await Promise.all([
    db.messages.count({ where }),
    db.messages.findMany({
      where,
      distinct: ["user_id"],
      select: { user_id: true },
    }),
    db.verdicts.count({ where: { ...where, status: "deleted" } }),
    db.verdicts.count({ where: { ...where, status: "clean" } }),
  ]);

  return JSON.stringify({
    total_messages: total,
    active_users: active.length,
    flagged,
    clean,
  });
}

async function topChannels(guildId?: string, limit = 5): Promise<string> {
  const db = getDatabase();
  const rows = await db.messages.groupBy({
    by: ["channel_id"],
    where: scopeMessages(guildId),
    _count: { _all: true },
    orderBy: { _count: { channel_id: "desc" } },
    take: limit,
  });
  return JSON.stringify(
    rows.map((r) => ({ channel_id: r.channel_id, count: r._count._all })),
  );
}

async function recentActivity(
  guildId?: string,
  channelId?: string,
  limit = 5,
): Promise<string> {
  const db = getDatabase();
  const rows = await db.messages.findMany({
    where: scopeMessages(guildId, channelId),
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      id: true,
      username: true,
      user_id: true,
      channel_id: true,
      content: true,
      created_at: true,
      ai_status: true,
    },
  });
  return JSON.stringify(rows);
}

async function topFlagged(
  guildId?: string,
  channelId?: string,
  limit = 5,
): Promise<string> {
  const db = getDatabase();
  const rows = await db.verdicts.findMany({
    where: { status: "deleted", ...scopeMessages(guildId, channelId) },
    // Ranked by the decision, then by how hard the model judged it. `score` is
    // a number, so this is a real ranking and not a lexical sort.
    orderBy: [{ score: "desc" }, { messages: { created_at: "desc" } }],
    take: limit,
    select: {
      messages: {
        select: {
          id: true,
          username: true,
          channel_id: true,
          content: true,
          // Pipeline position — NOT the judgement. Kept so the chatbot can
          // report "still pending" honestly.
          ai_status: true,
          created_at: true,
        },
      },
      // The judgement itself. `messages.ai_status = 'flagged'` matches nothing
      // since the rewrite, which silently made this tool always answer "none".
      status: true,
      flags: true,
      analysis: true,
      score: true,
    },
  });

  return JSON.stringify(
    rows.map((r) => ({
      id: r.messages.id,
      username: r.messages.username,
      channel_id: r.messages.channel_id,
      content: r.messages.content,
      ai_status: r.messages.ai_status,
      created_at: r.messages.created_at,
      verdict_status: r.status,
      verdict_flags: r.flags,
      verdict_analysis: r.analysis,
      verdict_score: r.score,
    })),
  );
}

async function searchMessages(
  query: string,
  guildId?: string,
  channelId?: string,
  limit = 5,
): Promise<string> {
  const db = getDatabase();
  if (!query.trim()) return JSON.stringify({ error: "query kosong" });
  const rows = await db.messages.findMany({
    where: {
      ...scopeMessages(guildId, channelId),
      content: { contains: query, mode: "insensitive" },
    },
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      id: true,
      username: true,
      channel_id: true,
      content: true,
      created_at: true,
      ai_status: true,
    },
  });
  return JSON.stringify(rows);
}

async function userMessages(
  userId?: string,
  guildId?: string,
  channelId?: string,
  limit = 10,
): Promise<string> {
  const db = getDatabase();
  if (!userId) return JSON.stringify({ error: "userId wajib" });
  const rows = await db.messages.findMany({
    where: { user_id: userId, ...scopeMessages(guildId, channelId) },
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      id: true,
      channel_id: true,
      content: true,
      created_at: true,
      ai_status: true,
    },
  });
  return JSON.stringify(rows);
}

async function userProfile(userId?: string, guildId?: string): Promise<string> {
  const db = getDatabase();
  if (!userId) return JSON.stringify({ error: "userId wajib" });
  const rows = await db.user_profiles.findMany({
    where: { user_id: userId, ...(guildId ? { guild_id: guildId } : {}) },
    take: 1,
    select: {
      user_id: true,
      guild_id: true,
      profile_summary: true,
      last_analyzed_at: true,
    },
  });
  return JSON.stringify(rows[0] ?? { error: "profil tidak ditemukan" });
}

async function userReputation(
  _userId?: string,
  _guildId?: string,
): Promise<string> {
  // The per-user reputation feature (trust scores, streaks, infractions) was
  // removed from the gateway (migration 0016 drops user_reputations). Return
  // an honest "unavailable" answer from the derived moderation signals instead
  // of querying the now-dropped table.
  return JSON.stringify({
    available: false,
    message:
      "Skor trust/skala reputasi per-user telah dihapus dari sistem. Gunakan rasio pesan ter-flag vs total untuk menilai risiko (lihat dashboard Users).",
  });
}

async function channelCulture(channelId?: string): Promise<string> {
  const db = getDatabase();
  if (!channelId) return JSON.stringify({ error: "channelId wajib" });
  const rows = await db.channel_cultures.findMany({
    where: { channel_id: channelId },
    take: 1,
    select: {
      channel_id: true,
      culture_summary: true,
      last_analyzed_at: true,
    },
  });
  return JSON.stringify(rows[0] ?? { error: "culture tidak ditemukan" });
}

async function messageDetail(messageId?: string): Promise<string> {
  const db = getDatabase();
  if (!messageId) return JSON.stringify({ error: "messageId wajib" });
  const rows = await db.messages.findMany({
    where: { id: messageId },
    take: 1,
    select: {
      id: true,
      guild_id: true,
      channel_id: true,
      user_id: true,
      username: true,
      content: true,
      created_at: true,
      ai_status: true,
      ai_moderation_flags: true,
      ai_moderation_score: true,
      ai_categories: true,
      ai_analysis: true,
      ai_confidence: true,
    },
  });
  return JSON.stringify(rows[0] ?? { error: "pesan tidak ditemukan" });
}

async function messageReviews(
  guildId?: string,
  status?: string,
  limit = 10,
): Promise<string> {
  const db = getDatabase();
  const rows = await db.message_reviews.findMany({
    where: {
      ...(guildId ? { guild_id: guildId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      id: true,
      message_id: true,
      reviewer_id: true,
      status: true,
      notes: true,
      created_at: true,
      reviewed_at: true,
    },
  });
  return JSON.stringify(rows);
}

async function voiceRecordings(
  userId?: string,
  channelId?: string,
  guildId?: string,
  limit = 10,
): Promise<string> {
  const db = getDatabase();
  const rows = await db.voice_recordings.findMany({
    where: {
      ...(userId ? { user_id: userId } : {}),
      ...(channelId ? { channel_id: channelId } : {}),
      ...(guildId ? { guild_id: guildId } : {}),
    },
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      id: true,
      username: true,
      channel_name: true,
      filename: true,
      size_bytes: true,
      upload_status: true,
      transcription: true,
      created_at: true,
    },
  });
  return JSON.stringify(rows);
}

async function moderationTimeline(
  guildId?: string,
  channelId?: string,
  days = 14,
): Promise<string> {
  const db = getDatabase();
  const since = BigInt(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db.messages.findMany({
    where: { ...scopeMessages(guildId, channelId), created_at: { gte: since } },
    select: {
      created_at: true,
      verdicts: { select: { status: true } },
    },
  });

  // Bucketed in JS rather than with date_trunc: the builder has no time-bucket
  // expression, and grouping here keeps the result identical to the SQL it
  // replaces without approximating the date format.
  const byDay = new Map<
    string,
    { total: number; flagged: number; clean: number }
  >();
  for (const r of rows) {
    const day = new Date(Number(r.created_at)).toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { total: 0, flagged: 0, clean: 0 };
    bucket.total += 1;
    if (r.verdicts?.status === "deleted") bucket.flagged += 1;
    if (r.verdicts?.status === "clean") bucket.clean += 1;
    byDay.set(day, bucket);
  }

  return JSON.stringify(
    [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v })),
  );
}

async function corrections(_guildId?: string, limit = 10): Promise<string> {
  const db = getDatabase();
  const rows = await db.corrected_moderations.findMany({
    orderBy: { created_at: "desc" },
    take: limit,
    select: {
      id: true,
      message_id: true,
      original_flags: true,
      corrected_flags: true,
      correction_notes: true,
      content_snippet: true,
      created_at: true,
    },
  });
  return JSON.stringify(rows);
}
