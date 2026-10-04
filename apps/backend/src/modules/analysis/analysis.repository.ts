import { getDatabase } from "../../shared/database/index.js";
import { createChildLogger } from "../../shared/logger/index.js";
import {
  type MappedMessage,
  mapMessageRow,
} from "../../shared/utils/messageMapper.js";

const logger = createChildLogger("analysis.repository");

export interface AnalysisSearchQuery {
  q?: string;
  channelId?: string;
  guildId?: string;
  limit?: number;
}

// AnalysisSearchResult is identical to MappedMessage — reuse the shared mapper
export type AnalysisSearchResult = MappedMessage;

export class AnalysisRepository {
  async search(query: AnalysisSearchQuery): Promise<AnalysisSearchResult[]> {
    const db = getDatabase();
    const { q = "", channelId, guildId, limit = 20 } = query;

    logger.debug({ q, channelId, guildId, limit }, "Searching analysis");

    const rows = await db.messages.findMany({
      where: {
        content: { contains: q, mode: "insensitive" },
        ...(guildId ? { guild_id: guildId } : {}),
        ...(channelId ? { channel_id: channelId } : {}),
      },
      orderBy: { created_at: "desc" },
      take: limit,
    });

    return rows.map((r) => mapMessageRow(r as Record<string, unknown>));
  }
}

export const analysisRepository = new AnalysisRepository();
