import { desc, ilike, or } from "drizzle-orm";
import { executeAll, getDatabase } from "@/shared/database/drizzle";
import {
  channelCulturesTable,
  termGlossaryCacheTable,
} from "@/shared/database/schema";

export interface ChannelCultureRow {
  channel_id: string;
  guild_id: string | null;
  channel_name: string | null;
  culture_summary: string | null;
  last_analyzed_at: number | null;
}

/** Row shape of the grouped channel-name lookup below. */
interface ChannelNameRow {
  channel_id: string;
  name: string;
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
    const rows = await db
      .select()
      .from(channelCulturesTable)
      .where(
        search
          ? or(
              ilike(channelCulturesTable.channel_id, `%${search}%`),
              ilike(channelCulturesTable.culture_summary, `%${search}%`),
            )
          : undefined,
      )
      .orderBy(desc(channelCulturesTable.last_analyzed_at))
      .limit(limit);

    // The channel's display name only exists on captured messages, so it is
    // resolved with one grouped lookup rather than a query per row.
    const names = await this.channelNames(rows.map((r) => r.channel_id));

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
    // `executeAll` rather than `db.$queryRaw`: the shared Drizzle handle is
    // typed `NodePgDatabase<Record<string, unknown>>` (no schema generic), so
    // the query-builder escape hatches are not on it. `executeAll` is the
    // established raw-SQL path on that handle — see `init-drizzle.ts` — and it
    // converts `?` placeholders to `$N` itself.
    const rows = (await executeAll(
      `SELECT DISTINCT ON (channel_id) channel_id,
              metadata::jsonb -> 'channel' ->> 'channelName' AS name
         FROM messages
        WHERE channel_id = ANY($1::text[])
          AND metadata IS NOT NULL
          AND NULLIF(metadata::jsonb -> 'channel' ->> 'channelName', '') IS NOT NULL
        ORDER BY channel_id, created_at DESC`,
      [channelIds],
    )) as ChannelNameRow[];

    return new Map(rows.map((r) => [r.channel_id, r.name]));
  }

  /** Public read-only term knowledge base (resolved via Wikipedia/SearXNG). */
  async listGlossary(limit = 50, search?: string) {
    const db = getDatabase();
    const rows = await db
      .select()
      .from(termGlossaryCacheTable)
      .where(
        search
          ? or(
              ilike(termGlossaryCacheTable.term, `%${search}%`),
              ilike(termGlossaryCacheTable.definition, `%${search}%`),
            )
          : undefined,
      )
      .orderBy(
        desc(termGlossaryCacheTable.hit_count),
        desc(termGlossaryCacheTable.resolved_at),
      )
      .limit(limit);

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
