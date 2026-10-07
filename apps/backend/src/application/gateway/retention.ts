import { createChildLogger } from "../../infrastructure/logger/index.js"
import type { RetentionRepository } from "../../infrastructure/repositories/retention.repository.js"

const logger = createChildLogger("retention")

/** How often the sweep runs, and how long each table is kept. */
export interface RetentionSettings {
	/** Milliseconds between sweeps. */
	intervalMs: number
	/** Days of `messages` to keep. Unset or `<= 0` disables that sweep. */
	messagesDays?: number
	/** Days of `attachments` to keep. Unset or `<= 0` disables that sweep. */
	attachmentsDays?: number
}

export interface RetentionDeps {
	retention: RetentionRepository
	settings: RetentionSettings
}

/**
 * Periodic delete of captured rows older than the retention window.
 *
 * This file owns the *policy* — how often to sweep and how far back to keep —
 * and nothing else. The SQL, the batching and the row-level logging live in
 * `RetentionRepository`, which is what keeps `drizzle-orm` and the Drizzle
 * table objects out of the application layer.
 *
 * A tick that throws is logged and dropped: the interval keeps running, so a
 * transient database error does not silently end retention forever.
 */
export function startRetentionCleanup({
	retention,
	settings,
}: RetentionDeps): void {
	const { intervalMs, messagesDays, attachmentsDays } = settings

	logger.info(
		{ intervalMs, messagesDays, attachmentsDays },
		"Starting retention cleanup scheduler",
	)

	async function runCleanupTick(): Promise<void> {
		await retention.pruneMessages(messagesDays)
		await retention.pruneAttachments(attachmentsDays)
	}

	// Run immediately on start, then schedule.
	runCleanupTick().catch((error) => {
		logger.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"Initial retention cleanup tick failed",
		)
	})

	setInterval(() => {
		runCleanupTick().catch((error) => {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Retention cleanup tick failed",
			)
		})
	}, intervalMs)
}
