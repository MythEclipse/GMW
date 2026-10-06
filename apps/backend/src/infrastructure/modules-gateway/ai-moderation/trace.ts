/**
 * Pipeline tracing — one correlation key per message, from capture to verdict.
 *
 * ## Why this exists
 *
 * The audit that motivated this file: over 12 minutes of production running,
 * the worker emitted exactly ONE log line, and it was a failure. There was no
 * way to answer the only questions that matter when moderation misbehaves:
 *
 *   - Did this message ever get captured?
 *   - How long did it sit in the queue before anyone claimed it?
 *   - Which worker took it, and when?
 *   - How long did the model take?
 *   - What did the model actually say?
 *   - Where did it end up — analyzed, retry_wait, or dead?
 *
 * A `Map` of in-memory state cannot answer those questions, because the
 * message is captured by one process, claimed by another, and judged seconds
 * later. The correlation has to live in the log line itself.
 *
 * ## Design
 *
 * Every stage logs the SAME `trace` id, so `journalctl | grep <id>` returns
 * the whole life of one message in order. `trace` is the message id truncated
 * to something greppable, which means the id a user reports ("message stuck at
 * 17:42") is directly searchable.
 *
 * `elapsedMs` is measured from `capturedAt` (stored on the row) rather than
 * from process start, so it survives the hop between the capturing process and
 * the worker process. The per-stage duration is `t_stage`, and `waitMs` is the
 * time the message spent queued before it was claimed.
 *
 * Levels are deliberate: `debug` for per-message chatter (off in production,
 * on with LOG_LEVEL=debug), `info` for batch-level milestones so a normal
 * production log still shows throughput and latency.
 */

import type { Logger } from "../../logger/index.js"
import { createChildLogger } from "../../logger/index.js"

const log = createChildLogger("ai-moderation.trace")

/** Discord snowflakes are 17-19 digits; the tail is enough to disambiguate. */
export function traceId(messageId: string): string {
	return messageId.length <= 12 ? messageId : messageId.slice(-12)
}

/** Timestamps on `messages` are epoch milliseconds (bigint). */
export function toEpochMs(value: unknown): number | null {
	if (value === null || value === undefined) return null
	if (typeof value === "number") return Number.isFinite(value) ? value : null
	if (typeof value === "bigint") return Number(value)
	if (typeof value === "string") {
		const n = Number(value)
		return Number.isFinite(n) ? n : null
	}
	return null
}

/** Human-readable duration for log lines: `1.2s`, `340ms`, `2m05s`. */
export function humanMs(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a"
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	return `${m}m${String(s).padStart(2, "0")}s`
}

/** Fields shared by every stage line for one message. */
export interface TraceFields {
	trace: string
	messageId: string
}

/** Stage 1 — the gateway persisted a new message. */
export function logCaptured(
	logger: Logger,
	m: {
		messageId: string
		channelId: string
		authorId: string
		hasMedia: boolean
		contentChars: number
	},
): void {
	logger.debug(
		{
			trace: traceId(m.messageId),
			messageId: m.messageId,
			channelId: m.channelId,
			authorId: m.authorId,
			hasMedia: m.hasMedia,
			contentChars: m.contentChars,
			stage: "captured",
		},
		"message captured; queued for analysis",
	)
}

/** Stage 2 — a worker took ownership of the rows. */
export function logClaimed(
	workerId: string,
	msgs: Array<{ id: string; createdAt: unknown; username?: string | null }>,
): { totalWaitMs: number | null; oldestWaitMs: number | null } {
	const now = Date.now()
	let totalWaitMs: number | null = null
	let oldestWaitMs: number | null = null

	for (const m of msgs) {
		const created = toEpochMs(m.createdAt)
		const waitMs = created === null ? null : now - created
		if (waitMs !== null) {
			totalWaitMs = (totalWaitMs ?? 0) + waitMs
			if (oldestWaitMs === null || waitMs > oldestWaitMs) oldestWaitMs = waitMs
		}
		log.debug(
			{
				trace: traceId(m.id),
				messageId: m.id,
				workerId,
				stage: "claimed",
				waitMs,
				waitHuman: humanMs(waitMs),
				queuedSince: created === null ? null : new Date(created).toISOString(),
			},
			"message claimed by worker",
		)
	}

	const avg =
		totalWaitMs === null || msgs.length === 0 ? null : totalWaitMs / msgs.length
	log.info(
		{
			workerId,
			stage: "claimed-batch",
			count: msgs.length,
			avgWaitMs: avg === null ? null : Math.round(avg),
			oldestWaitHuman: humanMs(oldestWaitMs),
			ids: msgs.slice(0, 5).map((m) => traceId(m.id)),
		},
		"worker claimed a batch",
	)

	return {
		totalWaitMs: avg,
		oldestWaitMs,
	}
}

/**
 * Stage 2.5 — what Hindsight contributed to this batch's prompt.
 *
 * Separate from the LLM line because a batch that recalls nothing is a
 * different situation from a batch where recall silently returned "", and
 * "memory_context is always empty" is the failure mode that looks exactly like
 * the feature working.
 */
export function logMemoryRecall(fields: {
	trace: string
	channels: number
	chars: number
}): void {
	log.info(
		{
			trace: fields.trace,
			stage: "memory-recall",
			channels: fields.channels,
			chars: fields.chars,
		},
		"hindsight memory attached to prompt",
	)
}

/** Stage 3 — the model call. `content` is logged at debug because it can be large. */
export function logLlmDone(fields: {
	trace: string
	batchSize: number
	model: string
	durationMs: number
	promptChars: number
	completionChars: number
	streamed: boolean
	content: string
	ids: string[]
}): void {
	log.info(
		{
			trace: fields.trace,
			stage: "llm",
			batchSize: fields.batchSize,
			model: fields.model,
			durationMs: fields.durationMs,
			durationHuman: humanMs(fields.durationMs),
			promptChars: fields.promptChars,
			completionChars: fields.completionChars,
			streamed: fields.streamed,
			// Every message that went into this call, so one line makes the whole
			// batch greppable without a second query.
			ids: fields.ids,
		},
		"model call complete",
	)
	// The raw response is the single most useful thing when the parser is
	// blamed, and the single most useless thing when it is not — hence debug.
	log.debug(
		{ trace: fields.trace, stage: "llm-raw", content: fields.content },
		"raw model response",
	)
}

/** Stage 4 — the batch result, including anything the parser had to reject. */
export function logBatchResult(fields: {
	trace: string
	requested: number
	ok: number
	errored: number
	missing: number
	batchFailed: boolean
	batchError?: string | null
	durationMs: number
}): void {
	const level =
		fields.batchFailed || fields.errored > 0
			? log.warn.bind(log)
			: log.info.bind(log)
	level(
		{
			trace: fields.trace,
			stage: "parsed",
			requested: fields.requested,
			ok: fields.ok,
			errored: fields.errored,
			missing: fields.missing,
			batchFailed: fields.batchFailed,
			batchError: fields.batchError ?? null,
			durationMs: Math.round(fields.durationMs),
		},
		fields.batchFailed
			? "batch unparseable; whole batch rescheduled"
			: "batch parsed",
	)
}

/** Stage 5 — the terminal write. `elapsedMs` is capture-to-verdict. */
export function logVerdictWritten(fields: {
	trace: string
	messageId: string
	status: string
	score: number | null
	attempts: number
	createdAt: unknown
	perMessageError?: string | null
}): void {
	const created = toEpochMs(fields.createdAt)
	const elapsedMs = created === null ? null : Date.now() - created
	log.info(
		{
			trace: fields.trace,
			messageId: fields.messageId,
			stage: "verdict",
			status: fields.status,
			score: fields.score,
			attempts: fields.attempts,
			perMessageError: fields.perMessageError ?? null,
			elapsedMs,
			elapsedHuman: humanMs(elapsedMs),
		},
		"verdict written; message complete",
	)
}

/** Stage 5b — a per-message problem that did NOT fail the whole batch. */
export function logMessageRequeued(fields: {
	trace: string
	messageId: string
	reason: string
	detail: string
	attempts: number | null
	createdAt: unknown
}): void {
	const created = toEpochMs(fields.createdAt)
	const elapsedMs = created === null ? null : Date.now() - created
	log.warn(
		{
			trace: fields.trace,
			messageId: fields.messageId,
			stage: "requeued",
			reason: fields.reason,
			detail: fields.detail,
			attempts: fields.attempts,
			elapsedMs,
			elapsedHuman: humanMs(elapsedMs),
		},
		"message requeued for another attempt",
	)
}

/** Stage 6 — the message exhausted its attempts and is parked. */
export function logParked(fields: {
	trace: string
	messageId: string
	attempts: number
	reason: string
	createdAt: unknown
}): void {
	const created = toEpochMs(fields.createdAt)
	const elapsedMs = created === null ? null : Date.now() - created
	log.error(
		{
			trace: fields.trace,
			messageId: fields.messageId,
			stage: "dead",
			attempts: fields.attempts,
			reason: fields.reason,
			elapsedMs,
			elapsedHuman: humanMs(elapsedMs),
		},
		"message parked as dead; needs a human",
	)
}

/** Aggregate heartbeat so a quiet queue is still visibly alive. */
export function logCycle(fields: {
	workerId: string
	claimed: number
	analyzed: number
	retried: number
	dead: number
	llmErrors: number
	cycleMs: number
	count: number
	skipped: number
	trace: string
}): void {
	log.info(
		{
			workerId: fields.workerId,
			trace: fields.trace,
			stage: "cycle",
			count: fields.count,
			claimed: fields.claimed,
			analyzed: fields.analyzed,
			requeued: fields.retried,
			dead: fields.dead,
			skipped: fields.skipped,
			llmErrors: fields.llmErrors,
			cycleMs: fields.cycleMs,
			cycleHuman: humanMs(fields.cycleMs),
		},
		"batch cycle complete",
	)
}
