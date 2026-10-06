import { getDatabase } from "../../infrastructure/database/drizzle.js"
import { createChildLogger } from "../../infrastructure/logger/index.js"
import { DashboardRepository } from "../../infrastructure/repositories/dashboard.repository.js"

const logger = createChildLogger("dashboard.service")

export interface ListUsersQuery {
	limit: number
	cursor?: string
	search?: string
}

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

/**
 * Lazily constructed, not built at import time.
 *
 * `createDashboardService()` calls `getDatabase()`, which throws until
 * `initializeDatabase()` has run. Deferring construction to first call keeps
 * importing this file free of a database, which is what lets a unit test
 * import the service and pass its own repository.
 *
 * Still one instance per process, which is what the oRPC router and the
 * gateway assume when they import `dashboardService`.
 */
let instance: DashboardService | undefined

export const createDashboardService = () =>
	new DashboardService(new DashboardRepository(getDatabase()))

export const dashboardService: Pick<
	DashboardService,
	| "getStats"
	| "getActivity"
	| "listUsers"
	| "getUserDetail"
	| "listChannels"
	| "getChannelDetail"
	| "getTopReactions"
	| "getTopReactors"
> = {
	getStats: (...args: Parameters<DashboardService["getStats"]>) => {
		instance ??= createDashboardService()
		return instance.getStats(...args) as ReturnType<
			DashboardService["getStats"]
		>
	},
	getActivity: (...args: Parameters<DashboardService["getActivity"]>) => {
		instance ??= createDashboardService()
		return instance.getActivity(...args) as ReturnType<
			DashboardService["getActivity"]
		>
	},
	listUsers: (...args: Parameters<DashboardService["listUsers"]>) => {
		instance ??= createDashboardService()
		return instance.listUsers(...args) as ReturnType<
			DashboardService["listUsers"]
		>
	},
	getUserDetail: (...args: Parameters<DashboardService["getUserDetail"]>) => {
		instance ??= createDashboardService()
		return instance.getUserDetail(...args) as ReturnType<
			DashboardService["getUserDetail"]
		>
	},
	listChannels: (...args: Parameters<DashboardService["listChannels"]>) => {
		instance ??= createDashboardService()
		return instance.listChannels(...args) as ReturnType<
			DashboardService["listChannels"]
		>
	},
	getChannelDetail: (
		...args: Parameters<DashboardService["getChannelDetail"]>
	) => {
		instance ??= createDashboardService()
		return instance.getChannelDetail(...args) as ReturnType<
			DashboardService["getChannelDetail"]
		>
	},
	getTopReactions: (
		...args: Parameters<DashboardService["getTopReactions"]>
	) => {
		instance ??= createDashboardService()
		return instance.getTopReactions(...args) as ReturnType<
			DashboardService["getTopReactions"]
		>
	},
	getTopReactors: (...args: Parameters<DashboardService["getTopReactors"]>) => {
		instance ??= createDashboardService()
		return instance.getTopReactors(...args) as ReturnType<
			DashboardService["getTopReactors"]
		>
	},
}
