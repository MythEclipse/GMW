import { inArray, lt } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import type { DatabaseHandle } from "../database/handle.js"
import type * as schema from "../database/schema.js"
import { attachmentsTable, messagesTable } from "../database/schema.js"
import { createChildLogger } from "../logger/index.js"

const logger = createChildLogger("retention.repository")

/** DB handle typed with the full schema so table/column refs resolve. */
type GatewayDatabase = NodePgDatabase<typeof schema>

/** Tables eligible for retention cleanup: string `id` + numeric `created_at`. */
type RetentionTable = typeof messagesTable | typeof attachmentsTable

type RetentionTimestampColumn =
	| typeof messagesTable.created_at
	| typeof attachmentsTable.created_at

const MS_PER_DAY = 24 * 60 * 60 * 1000
const BATCH_LIMIT = 1000

/**
 * Deletes rows that have aged past the retention window.
 *
 * Extracted from `application/gateway/retention.ts`, which used to hold the
 * Drizzle query and open the handle with the process-global `getDatabase()`.
 * The scheduling and the `days` policy stay in the application layer; only the
 * table selection and the SQL live here, which is what keeps the use-case free
 * of `drizzle-orm` and of `messagesTable`/`attachmentsTable`.
 */
export class RetentionRepository {
	constructor(private readonly db: DatabaseHandle) {}

	/** No-op when `days` is unset or `<= 0`; otherwise sweep `messages`. */
	pruneMessages(days: number | undefined): Promise<void> {
		return this.prune(messagesTable, messagesTable.created_at, days, "messages")
	}

	/** No-op when `days` is unset or `<= 0`; otherwise sweep `attachments`. */
	pruneAttachments(days: number | undefined): Promise<void> {
		return this.prune(
			attachmentsTable,
			attachmentsTable.created_at,
			days,
			"attachments",
		)
	}

	/**
	 * Delete rows older than `days`, in batches of up to `BATCH_LIMIT` ids.
	 *
	 * A failed DELETE is logged and swallowed, not rethrown: the scheduler that
	 * calls this runs on an interval, and one bad batch must not stop the next.
	 */
	private async prune(
		table: RetentionTable,
		timestampField: RetentionTimestampColumn,
		days: number | undefined,
		label: string,
	): Promise<void> {
		if (!days || days <= 0) {
			logger.debug({ label }, `Retention disabled for ${label}`)
			return
		}

		const cutoff = Date.now() - days * MS_PER_DAY
		const db = this.db as unknown as GatewayDatabase

		const expired = await db
			.select({ id: table.id })
			.from(table)
			.where(lt(timestampField, cutoff))
			.limit(BATCH_LIMIT)

		if (expired.length === 0) {
			logger.debug({ label }, `No expired ${label} found`)
			return
		}

		logger.info({ count: expired.length, label }, `Found expired ${label}`)

		try {
			await db.delete(table).where(
				inArray(
					table.id,
					expired.map((r) => r.id),
				),
			)
			logger.info({ count: expired.length, label }, `Deleted expired ${label}`)
		} catch (err) {
			logger.error({ err, label }, `Failed to delete expired ${label}`)
		}
	}
}
