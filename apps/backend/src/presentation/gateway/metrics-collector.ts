import { config } from "../../infrastructure/config/index.js"
import { getDrizzlePool } from "../../infrastructure/database/drizzle.js"
import type { Logger } from "../../infrastructure/logger/index.js"
import {
	registerCollector,
	setGauge,
} from "../../infrastructure/modules-gateway/gateway-metrics/index.js"

/**
 * Queue metrics, read from Postgres instead of process memory.
 *
 * ## Why this queries the database
 *
 * v1 exported `getAnalysisQueueStatus()` from the scheduler, which answered
 * from a `Map` of pending conversations plus a few module-level counters.
 * Those numbers described THIS process only — so a restarted gateway reported
 * an empty queue while thousands of messages sat in `retry_wait`, and a
 * second worker was entirely invisible. Every gauge here is now a GROUP BY
 * over the queue itself, which is both the truth and visible to any process.
 *
 * The old gauges (per-lane request depth, Piscina thread counts, circuit
 * breaker state) are deliberately NOT reimplemented. The lanes, thread pools,
 * and breaker no longer exist, and a metric with no way to become non-zero is
 * worse than no metric.
 */
export function registerPipelineMetrics(logger: Logger): void {
	registerCollector(() => {
		void emitQueueGauges(logger)
	})
}

async function emitQueueGauges(logger: Logger): Promise<void> {
	try {
		const pool = getDrizzlePool()
		const { rows } = await pool.query<{ ai_status: string; n: number }>(
			`SELECT ai_status, count(*)::int AS n
         FROM messages
        WHERE deleted_at IS NULL
        GROUP BY 1`,
		)

		const byState = Object.fromEntries(rows.map((r) => [r.ai_status, r.n]))

		// Backlog is work that exists and is not yet finished. `claimed` counts:
		// those rows are being actively worked, not lost.
		setGauge(
			"moderation_queue_backlog",
			(byState.pending ?? 0) + (byState.claimed ?? 0),
		)
		setGauge("moderation_queue_pending", byState.pending ?? 0)
		setGauge("moderation_queue_claimed", byState.claimed ?? 0)
		setGauge("moderation_queue_retry_wait", byState.retry_wait ?? 0)
		setGauge("moderation_queue_analyzed", byState.analyzed ?? 0)
		// Terminal, like `analyzed`: deliberately never analysed (a channel on the
		// skip list). Not backlog — a gauge that showed it as work owed would
		// never drain for a channel that is exempt by design.
		setGauge("moderation_queue_skipped", byState.skipped ?? 0)
		// `dead` is the actionable number: messages only a human can resolve.
		setGauge("moderation_queue_dead", byState.dead ?? 0)

		// Overdue retries. A sustained non-zero value means the LLM endpoint is
		// failing and the queue is filling up behind it.
		const { rows: overdue } = await pool.query<{ n: number }>(
			`SELECT count(*)::int AS n
         FROM messages
        WHERE ai_status = 'retry_wait'
          AND ready_for_work_at <= (extract(epoch FROM now()) * 1000)::bigint
          AND deleted_at IS NULL`,
		)
		setGauge("moderation_queue_retry_overdue", overdue[0]?.n ?? 0)
	} catch (err) {
		// A metrics scrape must never take the process down — and must not log on
		// every scrape either, since this runs on the Prometheus interval.
		logger.debug({ err }, "moderation queue metrics unavailable")
	}
}
