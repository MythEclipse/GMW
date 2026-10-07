import { createChildLogger } from "../../infrastructure/logger/index.js"
import {
	type ListModerationQuery,
	type ModerationRepository,
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
