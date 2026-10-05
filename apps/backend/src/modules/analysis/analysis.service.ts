import { getDatabase } from "@/shared/database/drizzle"
import { createChildLogger } from "@/shared/logger/index"
import { config } from "../../shared/config/index.js"
import type { AnalysisSearchQuery } from "./analysis.repository.js"
import { AnalysisRepository } from "./analysis.repository.js"

const logger = createChildLogger("analysis.service")

export type { AnalysisSearchQuery }

export class AnalysisService {
	constructor(private readonly repository: AnalysisRepository) {}

	async search(query: AnalysisSearchQuery) {
		const { q = "", channelId, limit = 20 } = query
		const guildId = config.MONITOR_GUILD_ID

		logger.debug({ q, channelId, limit, guildId }, "Searching analysis")

		const rows = await this.repository.search({
			q,
			channelId,
			guildId,
			limit,
		})

		return { results: rows }
	}
}

/**
 * Lazily constructed, not built at import time.
 *
 * `createAnalysisService()` calls `getDatabase()`, which throws until
 * `initializeDatabase()` has run. Deferring construction to first call keeps
 * importing this file free of a database, which is what lets a unit test
 * import the service and pass its own repository.
 *
 * Still one instance per process, which is what the oRPC router and the
 * gateway assume when they import `analysisService`.
 */
let instance: AnalysisService | undefined

export const createAnalysisService = () =>
	new AnalysisService(new AnalysisRepository(getDatabase()))

export const analysisService: Pick<AnalysisService, "search"> = {
	search: (...args: Parameters<AnalysisService["search"]>) => {
		instance ??= createAnalysisService()
		return instance.search(...args) as ReturnType<AnalysisService["search"]>
	},
}
