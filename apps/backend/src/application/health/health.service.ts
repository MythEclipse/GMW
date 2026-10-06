import { getDatabase } from "../../infrastructure/database/drizzle.js"
import { HealthRepository } from "../../infrastructure/repositories/health.repository.js"

/**
 * The composition point for this module.
 *
 * Services take their collaborators as constructor arguments and expose a
 * `create*` factory, so a test can pass fakes without touching the module-level
 * singletons the router and the gateway use.
 */
export interface HealthCheck {
	status: "healthy" | "degraded"
	timestamp: number
	database?: { connected: boolean; error?: string }
}

export class HealthService {
	constructor(private readonly repository: HealthRepository) {}

	async getHealth(verbose = false): Promise<HealthCheck> {
		const dbStatus = await this.repository.checkDatabaseConnection()

		return {
			status: dbStatus.connected ? "healthy" : "degraded",
			timestamp: Date.now(),
			...(verbose && {
				database: dbStatus,
			}),
		}
	}
}

export const createHealthService = () =>
	new HealthService(new HealthRepository(getDatabase()))

/**
 * Lazily constructed, NOT `const healthService = createHealthService()`.
 *
 * Building it eagerly calls `getDatabase()` at import time, and that throws
 * "Database not initialized" in any process that has not run
 * `initializeDatabase()` — including every unit test, even one that never
 * touches the health module. The getter defers construction to first use, so
 * importing this file is free and only actually asking for health status
 * requires a live handle.
 *
 * The export stays a singleton from a caller's point of view: `healthService`
 * is still one instance for the process, which is what the routes and the
 * deploy probe assume.
 */
let instance: HealthService | undefined

export const healthService: Pick<HealthService, "getHealth"> = {
	getHealth: (verbose = false) => {
		instance ??= createHealthService()
		return instance.getHealth(verbose)
	},
}
