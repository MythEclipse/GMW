import type { HealthRepository } from "../../infrastructure/repositories/health.repository.js"

/**
 * The composition point for this module.
 *
 * Services take their collaborators as constructor arguments, so a test can
 * pass fakes without touching a module-level singleton. The real graph is
 * built once in `presentation/composition.ts`.
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
