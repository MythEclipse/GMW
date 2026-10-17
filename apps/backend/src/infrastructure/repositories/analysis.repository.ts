import { and, desc, eq, ilike, inArray } from "drizzle-orm"
import {
	type MappedMessage,
	mapMessageRow,
} from "../../domain/utils/messageMapper.js"
import type { DatabaseHandle } from "../database/handle.js"
import { messagesTable } from "../database/schema.js"
import { createChildLogger } from "../logger/index.js"

const logger = createChildLogger("analysis.repository")

export interface AnalysisSearchQuery {
	q?: string
	channelId?: string
	/**
	 * Guild scope. A single id or the full allow-list, so the caller does not
	 * have to know which one the deployment configured.
	 *
	 * It used to be a single optional string that every caller passed from
	 * `config.MONITOR_GUILD_ID` — the DEPRECATED singular. Capture, meanwhile,
	 * honours `EFFECTIVE_MONITOR_GUILD_IDS`. On a multi-guild deployment that
	 * mismatch made this search blind to every guild but the first: the rows
	 * were captured and judged, and a search returned nothing.
	 */
	guildIds?: string[]
	limit?: number
}

// AnalysisSearchResult is identical to MappedMessage — reuse the shared mapper
export type AnalysisSearchResult = MappedMessage

export class AnalysisRepository {
	constructor(private readonly db: DatabaseHandle) {}

	async search(query: AnalysisSearchQuery): Promise<AnalysisSearchResult[]> {
		const { q = "", channelId, guildIds, limit = 20 } = query

		logger.debug({ q, channelId, guildIds, limit }, "Searching analysis")

		// `ilike` replaces Prisma's `{contains, mode: "insensitive"}`. An empty
		// search string must still match every row, so it stays in the WHERE
		// clause as `%%` rather than being dropped — same result set, one less
		// special case than Prisma's `contains: ""` needed.
		const conditions = [ilike(messagesTable.content, `%${q}%`)]
		// An EMPTY list means "no scope configured" and must not become an
		// `IN ()` that matches nothing by accident — the caller passes the
		// effective list, so empty really is unscoped.
		if (guildIds && guildIds.length > 0) {
			conditions.push(inArray(messagesTable.guild_id, guildIds))
		}
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
