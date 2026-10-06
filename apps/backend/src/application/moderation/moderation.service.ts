import { getDatabase } from "../../infrastructure/database/drizzle.js"
import { createChildLogger } from "../../infrastructure/logger/index.js"
import {
	type ListModerationQuery,
	ModerationRepository,
} from "../../infrastructure/repositories/moderation.repository.js"

const logger = createChildLogger("moderation.service")

export class ModerationService {
	constructor(private readonly repository: ModerationRepository) {}

	async getStats() {
		return this.repository.getStats()
	}

	async getTrends(days = 30) {
		return this.repository.getTrends(days)
	}

	async getTopFlaggedDomains(days = 30) {
		return this.repository.getTopFlaggedDomains(days)
	}

	async getTopFlaggedChannels(days = 30) {
		return this.repository.getTopFlaggedChannels(days)
	}

	async getHourlyModeration(days = 30) {
		return this.repository.getHourlyModeration(days)
	}

	async getByCategory(days = 30, category: string) {
		return this.repository.getByCategory(days, category)
	}

	async getCoverage(days = 30) {
		return this.repository.getCoverage(days)
	}

	async listActions(query: ListModerationQuery) {
		logger.debug({ query }, "Listing moderation actions")
		return this.repository.listActions(query)
	}
}

/**
 * Lazily constructed, not built at import time.
 *
 * `createModerationService()` calls `getDatabase()`, which throws until
 * `initializeDatabase()` has run. Deferring construction to first call keeps
 * importing this file free of a database, which is what lets a unit test
 * import the service and pass its own repository.
 *
 * Still one instance per process, which is what the oRPC router and the
 * gateway assume when they import `moderationService`.
 */
let instance: ModerationService | undefined

export const createModerationService = () =>
	new ModerationService(new ModerationRepository(getDatabase()))

export const moderationService: Pick<
	ModerationService,
	| "getStats"
	| "getTrends"
	| "getTopFlaggedDomains"
	| "getTopFlaggedChannels"
	| "getHourlyModeration"
	| "getByCategory"
	| "getCoverage"
	| "listActions"
> = {
	getStats: (...args: Parameters<ModerationService["getStats"]>) => {
		instance ??= createModerationService()
		return instance.getStats(...args) as ReturnType<
			ModerationService["getStats"]
		>
	},
	getTrends: (...args: Parameters<ModerationService["getTrends"]>) => {
		instance ??= createModerationService()
		return instance.getTrends(...args) as ReturnType<
			ModerationService["getTrends"]
		>
	},
	getTopFlaggedDomains: (
		...args: Parameters<ModerationService["getTopFlaggedDomains"]>
	) => {
		instance ??= createModerationService()
		return instance.getTopFlaggedDomains(...args) as ReturnType<
			ModerationService["getTopFlaggedDomains"]
		>
	},
	getTopFlaggedChannels: (
		...args: Parameters<ModerationService["getTopFlaggedChannels"]>
	) => {
		instance ??= createModerationService()
		return instance.getTopFlaggedChannels(...args) as ReturnType<
			ModerationService["getTopFlaggedChannels"]
		>
	},
	getHourlyModeration: (
		...args: Parameters<ModerationService["getHourlyModeration"]>
	) => {
		instance ??= createModerationService()
		return instance.getHourlyModeration(...args) as ReturnType<
			ModerationService["getHourlyModeration"]
		>
	},
	getByCategory: (...args: Parameters<ModerationService["getByCategory"]>) => {
		instance ??= createModerationService()
		return instance.getByCategory(...args) as ReturnType<
			ModerationService["getByCategory"]
		>
	},
	getCoverage: (...args: Parameters<ModerationService["getCoverage"]>) => {
		instance ??= createModerationService()
		return instance.getCoverage(...args) as ReturnType<
			ModerationService["getCoverage"]
		>
	},
	listActions: (...args: Parameters<ModerationService["listActions"]>) => {
		instance ??= createModerationService()
		return instance.listActions(...args) as ReturnType<
			ModerationService["listActions"]
		>
	},
}
