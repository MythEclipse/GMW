import { describe, expect, it, vi } from "vitest"
import { HealthService } from "../src/application/health/health.service.js"
import { HealthRepository } from "../src/infrastructure/repositories/health.repository.js"

/**
 * The payoff from injecting the database handle: these assertions run with no
 * Postgres, no pool, and no `initializeDatabase()`.
 *
 * Before the repository took a `QueryExecutor`, `checkDatabaseConnection()`
 * called the process-global `getDatabase()`, which throws "Database not
 * initialized" — so this file could not have existed. That constraint is why
 * vitest.config.ts sets `fileParallelism: false`: ten integration files share a
 * database and truncate each other's tables.
 */

/** Stands in for a Drizzle handle. Only `execute` is ever called. */
const fakeDb = (impl?: () => Promise<unknown>) => ({
	execute: vi.fn(impl ?? (async () => [{ "1": 1 }])),
})

const repo = (impl?: () => Promise<unknown>) =>
	new HealthRepository(fakeDb(impl) as never)

describe("HealthService", () => {
	it("reports healthy when the database answers", async () => {
		const service = new HealthService(repo())

		const health = await service.getHealth()

		expect(health.status).toBe("healthy")
		expect(health.timestamp).toBeTypeOf("number")
	})

	it("reports degraded when the database fails", async () => {
		const service = new HealthService(
			repo(async () => {
				throw new Error("connection refused")
			}),
		)

		const health = await service.getHealth()

		expect(health.status).toBe("degraded")
	})

	it("omits the database detail unless verbose", async () => {
		const service = new HealthService(repo())

		expect(await service.getHealth()).not.toHaveProperty("database")
		expect(await service.getHealth(true)).toHaveProperty("database")
	})

	it("asks the database exactly once per health check", async () => {
		const db = fakeDb()
		const service = new HealthService(new HealthRepository(db as never))

		await service.getHealth()

		expect(db.execute).toHaveBeenCalledTimes(1)
	})
})

describe("HealthRepository", () => {
	it("does not throw when the database is unreachable", async () => {
		// The deploy probe hits this path; a throw here would take down
		// deploy-direct.sh rather than reporting an unhealthy service.
		await expect(
			repo(async () => {
				throw new Error("ECONNREFUSED")
			}).checkDatabaseConnection(),
		).resolves.toEqual({ connected: false, error: "ECONNREFUSED" })
	})

	it("preserves a non-Error rejection as a string", async () => {
		await expect(
			repo(async () => {
				throw "plain string failure"
			}).checkDatabaseConnection(),
		).resolves.toEqual({ connected: false, error: "plain string failure" })
	})
})
