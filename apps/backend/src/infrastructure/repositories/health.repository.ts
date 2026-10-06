import { type SQL, sql } from "drizzle-orm"
import { createChildLogger } from "../logger/index.js"

const logger = createChildLogger("health.repository")

/**
 * The database handle, narrowed to what a repository actually needs.
 *
 * Deliberately structural rather than the concrete Drizzle type: a repository
 * declares "I can run a query", and a test passes an object with `execute`. That
 * is what makes a repository unit-testable without Postgres — the alternative
 * (calling the process-global `getDatabase()`) throws unless
 * `initializeDatabase()` ran first, which is why every repository test in this
 * suite needs a live database today.
 */
export interface QueryExecutor {
	execute(query: SQL): Promise<unknown>
}

export class HealthRepository {
	constructor(private readonly db: QueryExecutor) {}

	async checkDatabaseConnection() {
		try {
			logger.debug("Running database health check")
			// Drizzle's `sql` template, not Prisma's `$queryRaw`. This endpoint is
			// what deploy-direct.sh probes on every deploy, so it is the first query
			// ported off Prisma (P1a) — retiring Prisma can no longer break deploys.
			await this.db.execute(sql`SELECT 1`)
			logger.debug("Database health check passed")
			return { connected: true }
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			logger.error({ error: message }, "Database health check failed")
			return { connected: false, error: message }
		}
	}
}
