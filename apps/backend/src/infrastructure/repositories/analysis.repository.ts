import { and, desc, eq, ilike } from "drizzle-orm"
import {
	type MappedMessage,
	mapMessageRow,
} from "../../domain/utils/messageMapper.js"
import { getDatabase } from "../database/drizzle.js"
import type { DatabaseHandle } from "../database/handle.js"
import { messagesTable } from "../database/schema.js"
import { createChildLogger } from "../logger/index.js"

const logger = createChildLogger("analysis.repository")

export interface AnalysisSearchQuery {
	q?: string
	channelId?: string
	guildId?: string
	limit?: number
}

// AnalysisSearchResult is identical to MappedMessage — reuse the shared mapper
export type AnalysisSearchResult = MappedMessage

export class AnalysisRepository {
	constructor(private readonly db: DatabaseHandle) {}

	async search(query: AnalysisSearchQuery): Promise<AnalysisSearchResult[]> {
		const { q = "", channelId, guildId, limit = 20 } = query

		logger.debug({ q, channelId, guildId, limit }, "Searching analysis")

		// `ilike` replaces Prisma's `{contains, mode: "insensitive"}`. An empty
		// search string must still match every row, so it stays in the WHERE
		// clause as `%%` rather than being dropped — same result set, one less
		// special case than Prisma's `contains: ""` needed.
		const conditions = [ilike(messagesTable.content, `%${q}%`)]
		if (guildId) conditions.push(eq(messagesTable.guild_id, guildId))
		if (channelId) conditions.push(eq(messagesTable.channel_id, channelId))

		const rows = await this.db
			.select()
			.from(messagesTable)
			.where(and(...conditions))
			.orderBy(desc(messagesTable.created_at))
			.limit(limit)

		// `mapMessageRow` is ORM-agnostic: it reads a plain record and coerces the
		// bigint columns itself, so the Drizzle row needs no reshaping first.
		return rows.map((r) => mapMessageRow(r as Record<string, unknown>))
	}
}
