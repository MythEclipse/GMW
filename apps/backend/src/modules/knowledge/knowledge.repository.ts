import { getDatabase } from "../../shared/database/index.js";

export interface ChannelCultureRow {
  channel_id: string;
  guild_id: string | null;
  channel_name: string | null;
  culture_summary: string | null;
  last_analyzed_at: number | null;
}

export interface GlossaryRow {
  term: string;
  definition: string;
  source_url: string;
  resolved_at: number;
  hit_count: number;
}

export interface EditHistoryRow {
  id: string;
  message_id: string;
  old_content: string;
  edited_at: number;
  channel_id: string | null;
  channel_name: string | null;
  username: string | null;
}

export class KnowledgeRepository {
  /** Public read-only channel culture glossary (AI-generated norms/slang). */
  async listChannelCultures(limit = 50, search?: string) {
    const db = getDatabase();
    const rows = await db.channel_cultures.findMany({
      where: search
        ? {
            OR: [
              { channel_id: { contains: search, mode: "insensitive" } },
              { culture_summary: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { last_analyzed_at: "desc" },
      take: limit,
    });

    // The channel's display name only exists on captured messages, so it is
    // resolved with one grouped lookup rather than a query per row.
    const names = await this.channelNames(
      rows.map((r) => r.channel_id),
    );

    return rows.map((r) => ({
      channel_id: r.channel_id,
      guild_id: r.guild_id,
      channel_name: names.get(r.channel_id) ?? r.channel_id,
      culture_summary: r.culture_summary,
      last_analyzed_at: Number(r.last_analyzed_at),
    }));
  }

  private async channelNames(
    channelIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (channelIds.length === 0) return new Map();
    const db = getDatabase();
    const rows = await db.$queryRaw<{ channel_id: string; name: string }[]>`
      SELECT DISTINCT ON (channel_id) channel_id,
             metadata::jsonb -> 'channel' ->> 'channelName' AS name
        FROM messages
       WHERE channel_id = ANY(${channelIds}::text[])
         AND metadata IS NOT NULL
         AND NULLIF(metadata::jsonb -> 'channel' ->> 'channelName', '') IS NOT NULL
       ORDER BY channel_id, created_at DESC
    `;
    return new Map(rows.map((r) => [r.channel_id, r.name]));
  }

  /** Public read-only term knowledge base (resolved via Wikipedia/SearXNG). */
  async listGlossary(limit = 50, search?: string) {
    const db = getDatabase();
    const rows = await db.term_glossary_cache.findMany({
      where: search
        ? {
            OR: [
              { term: { contains: search, mode: "insensitive" } },
              { definition: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: [{ hit_count: "desc" }, { resolved_at: "desc" }],
      take: limit,
    });

    return rows.map((r) => ({
      term: r.term,
      definition: r.definition ?? "",
      source_url: r.source_url ?? "",
      resolved_at: Number(r.resolved_at),
      hit_count: r.hit_count ?? 0,
    }));
  }
}

export const knowledgeRepository = new KnowledgeRepository();
