import { createChildLogger } from "../../infrastructure/logger/index.js"
import {
	type AnalysisRepository,
	type AnalysisSearchQuery,
} from "../../infrastructure/repositories/analysis.repository.js"

const logger = createChildLogger("analysis.service")

export type { AnalysisSearchQuery }

/** The one setting this use-case needs, supplied by the composition root. */
export interface AnalysisSettings {
	/**
	 * Guilds whose messages are in scope — the EFFECTIVE allow-list from
	 * `config.EFFECTIVE_MONITOR_GUILD_IDS`, not the deprecated singular.
	 * See `domain/config/guildScope.ts` for why the list is the source of truth.
	 */
	monitorGuildIds: string[]
}

export class AnalysisService {
	constructor(
		private readonly repository: AnalysisRepository,
		private readonly settings: AnalysisSettings,
	) {}

	async search(query: AnalysisSearchQuery) {
		const { q = "", channelId, limit = 20 } = query
		const guildIds = this.settings.monitorGuildIds

		logger.debug({ q, channelId, limit, guildIds }, "Searching analysis")

		const rows = await this.repository.search({
			q,
			channelId,
			guildIds,
			limit,
		})

		return { results: rows }
	}
}
