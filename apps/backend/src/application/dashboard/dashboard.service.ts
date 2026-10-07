import type { ListUsersQuery } from "../../domain/dashboard/dashboard.js"
import { createChildLogger } from "../../infrastructure/logger/index.js"
import type { DashboardRepository } from "../../infrastructure/repositories/dashboard.repository.js"

const logger = createChildLogger("dashboard.service")

export type { ListUsersQuery }

export class DashboardService {
	constructor(private readonly repository: DashboardRepository) {}

	async getStats() {
		logger.debug("Fetching dashboard stats")
		return this.repository.getStats()
	}

	async getActivity(days: number) {
		logger.debug({ days }, "Fetching dashboard activity")
		return this.repository.getActivity(days)
	}

	async listUsers(query: ListUsersQuery) {
		logger.debug({ query }, "Listing dashboard users")
		return this.repository.listUsers(query)
	}

	async getUserDetail(userId: string) {
		logger.debug({ userId }, "Fetching user detail")
		return this.repository.getUserDetail(userId)
	}

	async listChannels(query: {
		limit: number
		search?: string
		guildId?: string
	}) {
		logger.debug({ query }, "Listing dashboard channels")
		return this.repository.listChannels(query)
	}

	async getChannelDetail(channelId: string) {
		logger.debug({ channelId }, "Fetching channel detail")
		return this.repository.getChannelDetail(channelId)
	}

	async getTopReactions(limit: number) {
		logger.debug({ limit }, "Fetching top reactions")
		return this.repository.getTopReactions(limit)
	}

	async getTopReactors(limit: number) {
		logger.debug({ limit }, "Fetching top reactors")
		return this.repository.getTopReactors(limit)
	}
}
