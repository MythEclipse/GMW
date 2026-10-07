import { asc } from "drizzle-orm"
import type { DatabaseHandle } from "../database/handle.js"
import { uiStateTable } from "../database/schema.js"

/**
 * Persistence for the dashboard's opaque `ui_state` key/value bag.
 *
 * Extracted from `application/ui-state/ui-state.service.ts`: the service used
 * to open the handle itself via the process-global `getDatabase()`, which is
 * exactly the dependency a use-case may not take — it threw "Database not
 * initialized" in any process that had not booted the pool, including the
 * WebSocket path that reads state on connect. The service receives this now.
 *
 * Row shape (synthetic example):
 *   `ui_state(key = 'theme', value = '"dark"', updated_at = 1791358130000)`
 * where `updated_at` is milliseconds since the Unix epoch and `value` holds a
 * JSON document encoded as text.
 */
export class UiStateRepository {
	constructor(private readonly db: DatabaseHandle) {}

	/** Every row ordered by key, with `value` parsed back out of its JSON wrapper. */
	async getAll(): Promise<Record<string, unknown>> {
		const rows = await this.db
			.select()
			.from(uiStateTable)
			.orderBy(asc(uiStateTable.key))

		const result: Record<string, unknown> = {}
		for (const row of rows) {
			try {
				result[row.key] = JSON.parse(row.value)
			} catch {
				result[row.key] = row.value
			}
		}

		return result
	}

	/**
	 * Upsert each key, one statement per key.
	 *
	 * `onConflictDoUpdate` rather than a read-then-write: it states the same
	 * single-statement intent (Prisma's `upsert({where, create, update})`) and
	 * closes the race a check-then-insert would open.
	 */
	async putAll(updates: Record<string, unknown>): Promise<void> {
		const now = Date.now()

		for (const [key, value] of Object.entries(updates)) {
			const serialized =
				typeof value === "string" ? value : JSON.stringify(value)

			await this.db
				.insert(uiStateTable)
				.values({ key, value: serialized, updated_at: now })
				.onConflictDoUpdate({
					target: uiStateTable.key,
					set: { value: serialized, updated_at: now },
				})
		}
	}
}
