import { createChildLogger } from "../../infrastructure/logger/index.js"
import {
	type AnalysisRepository,
	type AnalysisSearchQuery,
} from "../../infrastructure/repositories/analysis.repository.js"

const logger = createChildLogger("analysis.service")

export type { AnalysisSearchQuery }

/** The one setting this use-case needs, supplied by the composition root. */
export interface AnalysisSettings {
	/** Guild whose messages are in scope — see `domain/config/guildScope.ts`. */
	monitorGuildId?: string
}

export class AnalysisService {
	constructor(
		private readonly repository: AnalysisRepository,
		private readonly settings: AnalysisSettings,
	) {}

	async search(query: AnalysisSearchQuery) {
		const { q = "", channelId, limit = 20 } = query
		const guildId = this.settings.monitorGuildId

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
