import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm"
import type {
	MessageCreate,
	MessageQuery,
	MessageUpdate,
} from "../../application/messages/messages.schema.js"
import { readChannelName } from "../../domain/utils/channelName.js"
import { localHour } from "../../domain/utils/localTime.js"
import { mapMessageRow } from "../../domain/utils/messageMapper.js"
import { config } from "../config/index.js"
import { getDatabase } from "../database/drizzle.js"
import type { DatabaseHandle } from "../database/handle.js"
import {
	analysisAttemptsTable,
	attachmentsTable,
	messageEditsTable,
	messageReviewsTable,
	messagesTable,
	verdictsTable,
} from "../database/schema.js"
import { createChildLogger } from "../logger/index.js"
import type { PageResult } from "../shared-barrel/index.js"

/**
 * Thread/channel IDs to exclude from all message queries.
 * Messages in these threads (e.g. bot/selfbot spam) are skipped
 * both at capture time and when serving data
 * (backend API). Configured via EXCLUDED_THREAD_IDS and EXCLUDED_CHANNEL_IDS.
 */
const EXCLUDED_THREAD_IDS = config.EXCLUDED_THREAD_IDS

const logger = createChildLogger("messages.repository")

/**
 * Message columns plus the joined verdict, aliased so `mapMessageRow` can pick
 * them up as `verdict_*`.
 *
 * The join is LEFT because most messages have no verdict at all — anything
 * still queued, or analysed by the old pipeline before the rewrite. An INNER
 * join here would silently hide every unanalysed message from the dashboard.
 *
 * Prisma returns the nested `verdicts` object rather than flat `verdict_*`
 * columns, so `flattenVerdict` below re-projects it into the shape
 * `mapMessageRow` expects. Doing that in one place keeps every caller of the
 * mapper free of relation-handling.
 */
const messageColumns = {
	id: messagesTable.id,
	guild_id: messagesTable.guild_id,
	channel_id: messagesTable.channel_id,
	thread_id: messagesTable.thread_id,
	user_id: messagesTable.user_id,
	username: messagesTable.username,
	avatar_url: messagesTable.avatar_url,
	content: messagesTable.content,
	edited_content: messagesTable.edited_content,
	created_at: messagesTable.created_at,
	edited_at: messagesTable.edited_at,
	deleted_at: messagesTable.deleted_at,
	type: messagesTable.type,
	metadata: messagesTable.metadata,
	ai_status: messagesTable.ai_status,
	attempts: messagesTable.attempts,
	worker_id: messagesTable.worker_id,
	lease_until: messagesTable.lease_until,
	ready_for_work_at: messagesTable.ready_for_work_at,
	ai_moderation_flags: messagesTable.ai_moderation_flags,
	ai_moderation_score: messagesTable.ai_moderation_score,
	ai_analysis: messagesTable.ai_analysis,
	ai_categories: messagesTable.ai_categories,
	ai_confidence: messagesTable.ai_confidence,
	ai_analyzed_at: messagesTable.ai_analyzed_at,
	ai_analysis_duration_ms: messagesTable.ai_analysis_duration_ms,
	ai_error: messagesTable.ai_error,
	is_reply: messagesTable.is_reply,
	is_forward: messagesTable.is_forward,
	is_crosspost: messagesTable.is_crosspost,
	reference_message_id: messagesTable.reference_message_id,
	reference_channel_id: messagesTable.reference_channel_id,
	reference_guild_id: messagesTable.reference_guild_id,
} as const

/**
 * The verdict columns, ALIASED to `verdict_*`.
 *
 * Prisma returned a nested `verdicts` object and `flattenVerdict` re-projected
 * it. Drizzle has no nested selection, so the join selects these under their
 * flat names directly — which leaves `flattenVerdict` the identity on rows that
 * come from `messageWithVerdict`, so all eight of its call sites keep working
 * untouched.
 *
 * `auto_delete_state` is deliberately NOT aliased: `mapMessageRow` reads it
 * under that exact name, and only the gateway's enforcer writes it, which is
 * what lets the dashboard separate a bot deletion from a human one.
 * `messages.deleted_at` cannot — Discord's messageDelete fires for both.
 */
const verdictColumns = {
	verdict_status: verdictsTable.status,
	verdict_score: verdictsTable.score,
	verdict_confidence: verdictsTable.confidence,
	verdict_flags: verdictsTable.flags,
	verdict_categories: verdictsTable.categories,
	verdict_reason: verdictsTable.reason,
	verdict_analysis: verdictsTable.analysis,
	verdict_evidence: verdictsTable.evidence,
	verdict_model: verdictsTable.model,
	verdict_updated_at: verdictsTable.updated_at,
	auto_delete_state: verdictsTable.auto_delete_state,
} as const

/**
 * The full message projection: every message column plus the flattened verdict.
 *
 * LEFT JOIN, deliberately. An INNER join would silently hide every unanalysed
 * message from the dashboard — including anything still queued, or analysed by
 * the old pipeline before the rewrite.
 */
const messageWithVerdict = { ...messageColumns, ...verdictColumns }

/**
 * Re-project a row carrying verdict data into the flat `verdict_*` shape
 * `mapMessageRow` reads. A missing verdict leaves every `verdict_*` key null,
 * which the mapper already treats as "not judged".
 *
 * Handles BOTH shapes, and that is deliberate:
 *  - rows from `messageWithVerdict` already arrive flat (the join aliases them),
 *    so this is the identity plus a null-fill for a LEFT JOIN miss;
 *  - `reviewSelect` narrows the verdict columns, so its keys may be absent and
 *    the null-fill is what keeps the mapper's contract intact.
 *
 * The `verdicts` branch only runs if a nested object is present, which after the
 * Drizzle port nothing produces — it is kept so the two shapes cannot diverge
 * silently if a caller ever reintroduces a nested select.
 */
function flattenVerdict(row: Record<string, unknown>): Record<string, unknown> {
	const { verdicts: v, ...message } = row

	const VERDICT_KEYS = [
		"verdict_status",
		"verdict_score",
		"verdict_confidence",
		"verdict_flags",
		"verdict_categories",
		"verdict_reason",
		"verdict_analysis",
		"verdict_evidence",
		"verdict_model",
		"verdict_updated_at",
		"auto_delete_state",
	] as const

	if (v !== undefined) {
		const verdict = (v ?? {}) as Record<string, unknown>
		const projected: Record<string, unknown> = { ...message }
		for (const key of VERDICT_KEYS) {
			const source =
				key === "auto_delete_state"
					? "auto_delete_state"
					: key.slice("verdict_".length)
			projected[key] = verdict[source] ?? null
		}
		return projected
	}

	const filled: Record<string, unknown> = { ...message }
	for (const key of VERDICT_KEYS) {
		if (filled[key] === undefined) filled[key] = null
	}
	return filled
}

export interface AttachmentResult {
	id: string
	message_id: string
	guild_id: string
	channel_id: string
	thread_id: string | null
	user_id: string
	filename: string
	size: number
	type: string
	discord_url: string
	uploaded_url: string | null
	upload_status: string
	upload_error: string | null
	created_at: number
	uploaded_at: number | null
}

type MessageRow = ReturnType<typeof mapMessageRow>

export type { MessageRow }

/**
 * Build the NULL-safe "exclude spam threads" condition. Non-thread messages
 * (NULL thread_id) are always kept; thread messages are kept only when their
 * thread is not in the configured exclusion list.
 */
function excludeSpamThreads(): SQL | undefined {
	if (EXCLUDED_THREAD_IDS.length === 0) return undefined
	return or(
		isNull(messagesTable.thread_id),
		notInArray(messagesTable.thread_id, EXCLUDED_THREAD_IDS),
	)
}

/** Normalize a raw attachment DB row to the API shape. */
function mapAttachmentRow(r: Record<string, unknown>): AttachmentResult {
	return {
		id: String(r.id ?? ""),
		message_id: String(r.message_id ?? ""),
		guild_id: String(r.guild_id ?? ""),
		channel_id: String(r.channel_id ?? ""),
		thread_id: (r.thread_id as string | null) ?? null,
		user_id: String(r.user_id ?? ""),
		filename: String(r.filename ?? ""),
		size: Number(r.size ?? 0),
		type: String(r.type ?? ""),
		discord_url: String(r.discord_url ?? ""),
		uploaded_url: (r.uploaded_url as string | null) ?? null,
		upload_status: String(r.upload_status ?? "pending"),
		upload_error: (r.upload_error as string | null) ?? null,
		created_at: Number(r.created_at ?? 0),
		uploaded_at: (r.uploaded_at as number | null) ?? null,
	}
}

/** Select the first `limit + 1` rows so the caller can derive the next cursor. */
function cursorLimit(limit: number): number {
	return limit + 1
}

/**
 * The resume token for a page fetched with `limit + 1` rows.
 *
 * THE INDEX IS `limit - 1`, NOT `limit`, AND THAT IS THE WHOLE POINT
 *
 * `cursorLimit()` fetches one row MORE than it returns: the overflow row is
 * proof that another page exists. So the last row actually shown to the caller
 * sits at `rows[limit - 1]`, and the cursor must be built from THAT row — it is
 * the position the next page has to resume strictly after.
 *
 * Using `rows[limit]` instead (the overflow row itself) is off by one and loses
 * a row at every page boundary: the cursor points at a row the client never
 * received, the next page filters strictly `< cursor`, and that row is
 * therefore skipped forever. It is a silent data-loss bug, not a visible
 * error — the page still looks plausible.
 *
 * This was the bug in all four cursor-paginated queries in this file
 * (`findMany`, `findByChannel`, `getImageMessages`, `getAttachmentsByChannel`)
 * before `getReviewMessages`/`getRecentEdits` were added; the index is spelled
 * once here so the next one cannot repeat it.
 *
 * Stringified because `PageResult.nextCursor` is `string | null` and the queries
 * compare it with `Number(query.cursor)` on the way back in — one canonical
 * representation at the boundary, not two.
 *
 * Returns null when the fetched row count does not exceed `limit`, i.e. this
 * was the final page.
 */
function nextCursorAt<T extends { created_at: unknown }>(
	rows: T[],
	limit: number,
): string | null {
	if (rows.length <= limit) return null
	return String(rows[limit - 1].created_at)
}

/**
 * The review queue's sort key, defined ONCE in JS and once in SQL — and the two
 * pairs must agree.
 *
 * WHY THEY ARE DUPLICATED AT ALL
 *
 * `getReviewMessages` uses this key twice: once in ORDER BY, once inside the
 * cursor comparison. Writing it as a single SQL expression and reusing that
 * expression in both places is what makes drift impossible. It still has to
 * exist twice overall — once as SQL text for the query, once as a JS function
 * for encoding a returned row into the next cursor — so the pairing is
 * asserted by the tests rather than by the compiler.
 *
 * `actionRankOf` mirrors `reviewActionRank()`: ranking rather than sorting the
 * raw string is what puts `deleted` above `clean`, because those are the two
 * dispositions the model can reach. `NULL`/absent lands in bucket 0 and
 * therefore sorts last.
 */
const ACTION_RANKS: Record<string, number> = {
	deleted: 2,
	clean: 1,
}

function actionRankOf(recommendedAction: unknown): number {
	if (typeof recommendedAction !== "string") return 0
	return ACTION_RANKS[recommendedAction] ?? 0
}

/**
 * Score as a comparable integer, scaled by 100.
 *
 * This replaces the severity tier that used to sit between the action rank and
 * `created_at` in the queue order: with severity gone, how bad the model thought
 * something was IS the score, so that is what orders it.
 *
 * Scaled to an integer rather than carried as a raw float because the cursor
 * comparison tests this key for EQUALITY. The old SQL cast to `float8` before
 * multiplying so both sides did identical double arithmetic on a float4 input;
 * JS numbers are already float64, so the widening happens for free here.
 * `Math.floor` matches the SQL `FLOOR`, so a negative score would not diverge.
 *
 * Prisma's `orderBy` cannot hold a computed expression, so the queue is ordered
 * in JS. `compareReviewOrder` below is the exact inverse used for the cursor
 * filter, so sort and pagination cannot drift.
 */
function scoreRankOf(score: unknown): number {
	return Math.floor(Number(score ?? 0) * 100)
}

/** The four components the review sort key is built from, all pre-ranked. */
interface ReviewSortKey {
	id: string
	created_at: bigint | number
	/** `actionRankOf(verdict.status)` — the cursor stores this, not the string. */
	action: number
	/** `scoreRankOf(verdict.score)` — `floor(score * 100)`. */
	score: number
}

/**
 * Order rows by the full review-queue sort key, most-important first: action
 * rank, then score, then recency, then id.
 *
 * `id` is last because a cursor needs a total order — two rows sharing (action,
 * score, created_at) would otherwise be emitted in an arbitrary order and could
 * be duplicated or skipped across a page boundary.
 *
 * Both keys are pre-ranked, so a decoded cursor and a fetched row are directly
 * comparable — which is what lets this one function serve as both the sort and
 * the cursor filter.
 */
function compareReviewOrder(a: ReviewSortKey, b: ReviewSortKey): number {
	return (
		b.action - a.action ||
		b.score - a.score ||
		Number(b.created_at) - Number(a.created_at) ||
		(a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
	)
}

/**
 * A position in the review queue, resolved to the raw column values a row
 * comparison needs.
 *
 * Deliberately stores the RANK (`2` for deleted), not the string, so the decode
 * side needs no CASE of its own — the same numbering is used on both sides of
 * the comparison, which is the whole point of the encoding.
 */
interface ReviewCursor {
	action: number
	score: number
	created_at: number
	id: string
}

/** Encode/decode are lenient on purpose: a malformed cursor means "first page". */
function decodeReviewCursor(cursor?: string): ReviewCursor | null {
	if (!cursor) return null
	try {
		const raw = JSON.parse(
			Buffer.from(cursor, "base64").toString("utf-8"),
		) as Partial<ReviewCursor>
		if (
			typeof raw.action !== "number" ||
			typeof raw.score !== "number" ||
			typeof raw.created_at !== "number" ||
			typeof raw.id !== "string"
		) {
			return null
		}
		return {
			action: raw.action,
			score: raw.score,
			created_at: raw.created_at,
			id: raw.id,
		}
	} catch {
		return null
	}
}

function encodeReviewCursor(cursor: ReviewCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64")
}

/**
 * A page of enforcement-log rows plus the position to resume from.
 *
 * `results` is `MappedMessage[]`, the same shape `findMany` returns — not a
 * loose `Record<string, unknown>[]`. It was declared loosely because the rows
 * used to skip `mapMessageRow` entirely and go out as raw Prisma values, BigInt
 * columns included. Now that they are mapped, the loose type is a lie that also
 * hides every field from the compiler; `MessageRow` is the type consumers
 * already handle.
 */
export interface ReviewPageResult {
	results: MessageRow[]
	nextCursor: string | null
}

/** A position in the edit log: `(edited_at, id)`, both needed for a total order. */
interface EditCursor {
	edited_at: number
	id: string
}

/** A page of edit rows plus the position to resume from. */
export interface EditPageResult {
	results: {
		id: string
		message_id: string
		old_content: string
		new_content: string
		edited_at: number
		channel_id: string | null
		channel_name: string | null
		username: string | null
	}[]
	nextCursor: string | null
}

/** A malformed cursor degrades to "no cursor" — the first page — never to a throw. */
function decodeEditCursor(cursor?: string): EditCursor | null {
	if (!cursor) return null
	try {
		const raw = JSON.parse(
			Buffer.from(cursor, "base64").toString("utf-8"),
		) as Partial<EditCursor>
		if (typeof raw.edited_at !== "number" || typeof raw.id !== "string") {
			return null
		}
		return { edited_at: raw.edited_at, id: raw.id }
	} catch {
		return null
	}
}

function encodeEditCursor(cursor: EditCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64")
}

/**
 * Columns `getReviewMessages` returns — a narrower set than `messageWithVerdict`
 * (no edit/deletion bookkeeping, no legacy moderation flags) because the review
 * queue renders only these.
 */
const reviewSelect = {
	id: messagesTable.id,
	guild_id: messagesTable.guild_id,
	channel_id: messagesTable.channel_id,
	user_id: messagesTable.user_id,
	username: messagesTable.username,
	avatar_url: messagesTable.avatar_url,
	content: messagesTable.content,
	type: messagesTable.type,
	created_at: messagesTable.created_at,
	// Legacy `messages.ai_*` — the new worker never writes these, so they are
	// null for anything judged after the rewrite. The live judgement is the
	// verdict_* columns, joined from `verdicts`.
	ai_confidence: messagesTable.ai_confidence,
	ai_analysis: messagesTable.ai_analysis,
	is_reply: messagesTable.is_reply,
	is_forward: messagesTable.is_forward,
	is_crosspost: messagesTable.is_crosspost,
	reference_message_id: messagesTable.reference_message_id,
	reference_channel_id: messagesTable.reference_channel_id,
	reference_guild_id: messagesTable.reference_guild_id,
	// Retry state, so the review queue can distinguish "flagged, fine" from
	// "never finished, needs a human".
	ai_status: messagesTable.ai_status,
	attempts: messagesTable.attempts,
	worker_id: messagesTable.worker_id,
	// Flattened verdict columns, exactly as `messageWithVerdict` — the JS sort
	// below reads `r.verdicts?.status` today and reads `r.verdict_status` after.
	...verdictColumns,
} as const

/**
 * How much of the review queue to over-fetch, now that ordering happens in JS.
 *
 * The cursor's sort key cannot be pushed into `orderBy`, so `take` bounds the
 * scan rather than the page, and rows are trimmed after sorting. A factor
 * leaves headroom for the cursor filter to discard rows before the page fills;
 * if it ever truncates a full page, `nextCursor` still advances so paging
 * continues correctly — it just skips rows that sorted below the scan window.
 */
const REVIEW_SCAN_FACTOR = 4
const REVIEW_MIN_SCAN = 200

/**
 * Extra attachment rows to scan per page slot when resolving image messages.
 * Only the distinct message ids matter, so a message with N image attachments
 * consumes N rows of the window; this keeps the distinct count above the page
 * size. 4 covers the common case of a few images per message.
 */
const ATTACHMENT_ID_OVERSAMPLE = 4

/**
 * A condition on the message's verdict status.
 *
 * Prisma spelled this `{verdicts: {is: {status}}}`, which it compiles to an
 * EXISTS. An explicit EXISTS keeps that exact semantics — importantly it does
 * NOT become a join, so a message is not duplicated by a one-to-many.
 */
function hasVerdictStatus(status: string): SQL {
	return sql`EXISTS (SELECT 1 FROM ${verdictsTable} v WHERE v.message_id = ${messagesTable.id} AND v.status = ${status})`
}

/**
 * `or()` / `and()` without the `| undefined`.
 *
 * Drizzle types both as possibly-undefined because an EMPTY argument list has
 * no predicate to emit. Every call in this file passes at least one known-good
 * condition, so that branch is unreachable — and asserting it once here beats a
 * non-null assertion at each of the dozen call sites, with a comment explaining
 * why each one is safe.
 */
function anyOf(...conditions: SQL[]): SQL {
	return or(...conditions) as SQL
}

function allOf(...conditions: SQL[]): SQL {
	return and(...conditions) as SQL
}

/**
 * The enum unions for `messages.ai_status` and `messages.type`.
 *
 * Derived from the schema rather than re-declared: the Drizzle column carries
 * the pg-enum union, so a filter built from these types is checked against the
 * database definition at compile time. A hand-written copy would drift the
 * moment a status is added.
 */
type MessageAiStatus = NonNullable<
	(typeof messagesTable.$inferSelect)["ai_status"]
>
type MessageType = NonNullable<(typeof messagesTable.$inferSelect)["type"]>

export class MessagesRepository {
	constructor(private readonly db: DatabaseHandle) {}

	async findMany(query: MessageQuery): Promise<PageResult<MessageRow>> {
		const limit = query.limit ?? 50
		const conditions: SQL[] = []

		if (query.guildId) {
			conditions.push(eq(messagesTable.guild_id, query.guildId))
		}
		if (query.channelId) {
			conditions.push(eq(messagesTable.channel_id, query.channelId))
		}
		if (query.userId) {
			conditions.push(eq(messagesTable.user_id, query.userId))
		}
		if (query.status) {
			// Pipeline position, e.g. `dead`.
			conditions.push(
				eq(messagesTable.ai_status, query.status as MessageAiStatus),
			)
		}
		if (query.verdict) {
			// Moderation outcome. Filtering on messages.ai_status here would return
			// nothing at all, because the worker only ever writes `analyzed` to it.
			conditions.push(hasVerdictStatus(query.verdict))
		}
		if (query.needsReview) {
			conditions.push(hasVerdictStatus("deleted"))
		}
		if (query.cursor) {
			conditions.push(lt(messagesTable.created_at, Number(query.cursor)))
		}

		// Exclude spam threads (NULL-safe: non-thread messages are kept)
		const excludeThreads = excludeSpamThreads()
		if (excludeThreads) conditions.push(excludeThreads)

		const rows = await this.db
			.select(messageWithVerdict)
			.from(messagesTable)
			.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
			.where(and(...conditions))
			.orderBy(desc(messagesTable.created_at))
			.limit(cursorLimit(limit))

		const data = rows
			.slice(0, limit)
			.map((r) => mapMessageRow(flattenVerdict(r)))
		const nextCursor = nextCursorAt(rows, limit)

		logger.debug({ count: data.length, nextCursor }, "Found messages")
		return { data, nextCursor }
	}

	/**
	 * One message with its joined verdict.
	 *
	 * Left-joined like the list query: most messages have no verdict, and an
	 * inner join here would make the detail view 404 on anything unjudged.
	 */
	async findById(id: string) {
		const [row] = await this.db
			.select(messageWithVerdict)
			.from(messagesTable)
			.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
			.where(eq(messagesTable.id, id))
			.limit(1)

		if (!row) return null
		return mapMessageRow(flattenVerdict(row))
	}

	/**
	 * Every analysis attempt for a message, oldest first.
	 *
	 * This is the only way to answer "why is this one message stuck?" — the
	 * verdict table cannot, because a message that never got a verdict has no row
	 * there at all. Append-only, so it is a complete history of what the worker
	 * tried and what came back.
	 */
	async getAnalysisAttempts(messageId: string): Promise<
		Array<{
			attempt: number
			outcome: string
			error_code: string | null
			error_message: string | null
			duration_ms: number | null
			model: string | null
			worker_id: string | null
			prompt_tokens: number | null
			created_at: number
		}>
	> {
		const rows = await this.db
			.select({
				attempt: analysisAttemptsTable.attempt,
				outcome: analysisAttemptsTable.outcome,
				error_code: analysisAttemptsTable.error_code,
				error_message: analysisAttemptsTable.error_message,
				duration_ms: analysisAttemptsTable.duration_ms,
				model: analysisAttemptsTable.model,
				worker_id: analysisAttemptsTable.worker_id,
				prompt_tokens: analysisAttemptsTable.prompt_tokens,
				created_at: analysisAttemptsTable.created_at,
			})
			.from(analysisAttemptsTable)
			.where(eq(analysisAttemptsTable.message_id, messageId))
			.orderBy(
				asc(analysisAttemptsTable.created_at),
				asc(analysisAttemptsTable.id),
			)
		return rows.map((r) => ({
			attempt: Number(r.attempt),
			outcome: String(r.outcome),
			error_code: r.error_code ?? null,
			error_message: r.error_message ?? null,
			duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
			model: r.model ?? null,
			worker_id: r.worker_id ?? null,
			prompt_tokens: r.prompt_tokens === null ? null : Number(r.prompt_tokens),
			created_at: Number(r.created_at),
		}))
	}

	/**
	 * Edit history for a message: previous content snapshots (newest first).
	 * Stored in message_edits by the gateway's message-capture module.
	 */
	async getEditHistory(
		messageId: string,
	): Promise<Array<{ old_content: string; edited_at: number }>> {
		const rows = await this.db
			.select({
				old_content: messageEditsTable.old_content,
				edited_at: messageEditsTable.edited_at,
			})
			.from(messageEditsTable)
			.where(eq(messageEditsTable.message_id, messageId))
			.orderBy(desc(messageEditsTable.edited_at))
			.limit(50)
		return rows.map((r) => ({
			old_content: String(r.old_content ?? ""),
			edited_at: Number(r.edited_at ?? 0),
		}))
	}

	async findByChannel(
		channelId: string,
		query: MessageQuery,
	): Promise<PageResult<MessageRow>> {
		const limit = query.limit ?? 50
		const conditions: SQL[] = [eq(messagesTable.channel_id, channelId)]

		if (query.cursor) {
			conditions.push(lt(messagesTable.created_at, Number(query.cursor)))
		}

		// Exclude spam threads (NULL-safe)
		const excludeThreads = excludeSpamThreads()
		if (excludeThreads) conditions.push(excludeThreads)

		const rows = await this.db
			.select(messageWithVerdict)
			.from(messagesTable)
			.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
			.where(and(...conditions))
			.orderBy(desc(messagesTable.created_at))
			.limit(cursorLimit(limit))

		const data = rows
			.slice(0, limit)
			.map((r) => mapMessageRow(flattenVerdict(r)))
		const nextCursor = nextCursorAt(rows, limit)

		return { data, nextCursor }
	}

	/**
	 * Async generator that yields messages ONE AT A TIME for WS streaming.
	 * Each `.next()` runs its own bounded DB query (limit+1) advancing on the
	 * `created_at` cursor, so memory stays flat and the caller can emit one WS
	 * frame per message (no 50-row batch). Stops when a page returns < limit.
	 */
	async *streamMany(
		query: MessageQuery,
		pageSize = 50,
	): AsyncGenerator<MessageRow, void, unknown> {
		const conditions: SQL[] = []

		if (query.guildId) {
			conditions.push(eq(messagesTable.guild_id, query.guildId))
		}
		if (query.channelId) {
			conditions.push(eq(messagesTable.channel_id, query.channelId))
		}
		if (query.userId) {
			conditions.push(eq(messagesTable.user_id, query.userId))
		}
		if (query.status) {
			conditions.push(
				eq(messagesTable.ai_status, query.status as MessageAiStatus),
			)
		}
		const excludeThreads = excludeSpamThreads()
		if (excludeThreads) conditions.push(excludeThreads)

		let cursor: string | undefined = query.cursor

		while (true) {
			const pageConditions = [...conditions]
			if (cursor) {
				pageConditions.push(lt(messagesTable.created_at, Number(cursor)))
			}

			const rows = await this.db
				.select(messageWithVerdict)
				.from(messagesTable)
				.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
				.where(and(...pageConditions))
				.orderBy(desc(messagesTable.created_at))
				.limit(cursorLimit(pageSize))

			if (rows.length === 0) return

			const hasMore = rows.length > pageSize
			const pageRows = hasMore ? rows.slice(0, pageSize) : rows

			for (const r of pageRows) {
				yield mapMessageRow(flattenVerdict(r))
			}

			if (!hasMore) return
			cursor = String(rows[pageSize - 1].created_at)
		}
	}

	async create(data: MessageCreate) {
		const id = crypto.randomUUID()

		const [row] = await this.db
			.insert(messagesTable)
			.values({
				id,
				guild_id: data.guildId,
				channel_id: data.channelId,
				thread_id: data.threadId ?? null,
				user_id: data.userId,
				username: data.username,
				avatar_url: data.avatarUrl ?? null,
				content: data.content,
				edited_content: null,
				created_at: Date.now(),
				edited_at: null,
				deleted_at: null,
				type: (data.type ?? "text") as MessageType,
				metadata: null,
				ai_status: "pending",
				is_reply: data.isReply ?? false,
				is_forward: data.isForward ?? false,
				is_crosspost: data.isCrosspost ?? false,
				reference_message_id: data.referenceMessageId ?? null,
				reference_channel_id: data.referenceChannelId ?? null,
				reference_guild_id: data.referenceGuildId ?? null,
			})
			// A freshly created message has no verdict yet, but the returning select
			// is the full projection so `create` returns the same shape as
			// `findById` without a second round trip.
			.returning(messageColumns)

		return mapMessageRow(flattenVerdict(row))
	}

	async update(id: string, data: MessageUpdate) {
		const setData: Partial<typeof messagesTable.$inferInsert> = {}

		if (data.editedContent !== undefined) {
			setData.edited_content = data.editedContent
		}
		if (data.aiStatus !== undefined) {
			setData.ai_status = data.aiStatus as MessageAiStatus
		}
		if (data.aiAnalysis !== undefined) {
			setData.ai_analysis = data.aiAnalysis
		}
		if (data.aiCategories !== undefined) {
			setData.ai_categories = data.aiCategories
		}
		if (data.aiConfidence !== undefined) {
			setData.ai_confidence = data.aiConfidence
		}

		if (Object.keys(setData).length === 0) return this.findById(id)

		const [row] = await this.db
			.update(messagesTable)
			.set(setData)
			.where(eq(messagesTable.id, id))
			.returning(messageColumns)

		if (!row) return null
		return mapMessageRow(flattenVerdict(row))
	}

	/**
	 * Messages a human should look at: verdict `deleted` — the model decided the
	 * message should be removed — plus any that ran out of attempts (`dead`).
	 *
	 * This used to be `messages.ai_status IN ('warn','flagged')`, which returned
	 * an empty list forever once the new worker started writing only `analyzed` to
	 * that column. The judgement lives in `verdicts.status` now. Of the statuses
	 * that survived the collapse, `deleted` is the only one that means "a human
	 * must decide": `clean` is a pass, and `error` is a failed analysis attempt,
	 * which the `dead` retry path already covers.
	 *
	 * CURSOR PAGINATION MUST MATCH THE ORDER BY
	 *
	 * This query does not sort by recency — it sorts actionable-first, then by how
	 * hard the model judged the message, then newest, which is the order a
	 * moderator works the queue in. A `created_at`-only cursor would therefore be
	 * wrong here: every page re-sorts independently, so the same row reappears on
	 * page 2 while rows from page 1 that fell below the cut are silently lost.
	 *
	 * So the cursor carries the WHOLE sort key (action rank, score, created_at,
	 * id) and the WHERE clause replays it as a nested lexicographic comparison
	 * against the same key expressions the ORDER BY uses. Both sides read
	 * `reviewActionRank()` / `reviewScoreKey()` — one definition each — so the
	 * comparison cannot drift from the sort. `id` is the final tiebreak in the
	 * ORDER BY precisely so that a cursor has a total order to resume from: two
	 * rows sharing (action, score, created_at) would otherwise be returned in
	 * an arbitrary order and could be duplicated or skipped across pages.
	 */
	async getReviewMessages(
		channelId?: string,
		limit: number = 20,
		cursor?: string,
	): Promise<ReviewPageResult> {
		const conditions: SQL[] = [
			// `or()`/`and()` are typed `SQL | undefined` because they return
			// undefined for an empty argument list. Both calls here pass two
			// non-optional arguments, so the undefined branch is unreachable —
			// `allOf`/`anyOf` state that without a non-null assertion at every
			// call site.
			anyOf(hasVerdictStatus("deleted"), eq(messagesTable.ai_status, "dead")),
		]

		if (channelId) {
			conditions.push(eq(messagesTable.channel_id, channelId))
		}

		const excludeThreads = excludeSpamThreads()
		if (excludeThreads) conditions.push(excludeThreads)

		// The sort key is a computed expression (CASE rank, FLOOR(score*100)), and
		// Prisma's `orderBy` accepts only a column, so the queue is ordered in JS
		// via `compareReviewOrder`. Two consequences, both handled here:
		//
		//   * The cursor comparison was ALSO a computed expression in SQL, so it
		//     moves into the same JS filter. `compareReviewOrder(a, at) > 0` is the
		//     exact inverse of the sort, which is what keeps page 2 from
		//     re-emitting page 1's rows.
		//   * `take` can no longer bound the scan, since the ordering happens after
		//     the fetch. Rows are therefore over-fetched and trimmed below. The
		//     window is bounded by `REVIEW_SCAN_FACTOR * limit` to keep the fetch
		//     proportional to the page.
		const at = decodeReviewCursor(cursor)

		const rows = await this.db
			.select(reviewSelect)
			.from(messagesTable)
			.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
			.where(and(...conditions))
			.limit(Math.max(cursorLimit(limit) * REVIEW_SCAN_FACTOR, REVIEW_MIN_SCAN))

		const keyed = rows.map((r) => ({
			row: r,
			key: {
				id: r.id,
				created_at: r.created_at,
				action: actionRankOf(r.verdict_status ?? null),
				score: scoreRankOf(r.verdict_score ?? null),
			} satisfies ReviewSortKey,
		}))

		const ordered = keyed
			.filter((k) => (at ? compareReviewOrder(k.key, at) > 0 : true))
			.sort((a, b) => compareReviewOrder(a.key, b.key))

		const page = ordered.slice(0, cursorLimit(limit))
		// THROUGH `mapMessageRow`, unlike the pre-fix version of this line.
		//
		// `reviewSelect` reads Prisma's raw rows, and its BigInt columns
		// (`messages.created_at`, `verdicts.updated_at`) arrive as `bigint`
		// values. `JSON.stringify` cannot serialise those, so oRPC's wire
		// serializer tags them and the browser rebuilds them as REAL `BigInt`
		// objects — not numbers. Every arithmetic operation on them then throws
		// `TypeError: Cannot convert a BigInt value to number`, which took the
		// whole review/enforcement panel down with "This panel failed to render".
		//
		// `findMany` has never had this problem because it maps through
		// `mapMessageRow`, which coerces with `Number(...)`. This endpoint is the
		// only message query that skipped that boundary, so it is the only one
		// that shipped BigInts to the browser. Fixing it here rather than in the
		// frontend means every consumer of these rows — HTTP, WebSocket, the
		// stream_messages replay — gets numbers, exactly as `list` already does.
		const results = page
			.slice(0, limit)
			.map((k) => mapMessageRow(flattenVerdict(k.row)))

		// Cursor comes from the LAST RETURNED row (index `limit - 1`), not the
		// overflow row at index `limit` — see `nextCursorAt` for why that
		// distinction costs a row per page boundary if you get it backwards.
		const overflowed = page.length > limit
		const last = overflowed ? page[limit - 1].key : null
		const nextCursor =
			last && results.length === limit
				? encodeReviewCursor({
						action: last.action,
						score: last.score,
						created_at: Number(last.created_at),
						id: last.id,
					})
				: null

		return { results, nextCursor }
	}

	async delete(id: string): Promise<boolean> {
		// `deleteMany`'s `{count}` becomes the length of the returning clause.
		const deleted = await this.db
			.delete(messagesTable)
			.where(eq(messagesTable.id, id))
			.returning({ id: messagesTable.id })

		return deleted.length > 0
	}

	async getImageMessages(
		guildId: string,
		limit: number = 50,
	): Promise<PageResult<MessageRow>> {
		// Subquery: find distinct message_ids from attachments with image MIME type
		const attachmentConditions: SQL[] = [
			eq(attachmentsTable.guild_id, guildId),
			// `{startsWith: "image/"}` — a LIKE prefix match, which is what the
			// parameterised equivalent is. `sql` keeps the pattern a bound value.
			sql`${attachmentsTable.type} LIKE ${"image/%"}`,
		]
		// Exclude spam threads (NULL-safe for non-thread messages)
		const excludeAttachments =
			EXCLUDED_THREAD_IDS.length > 0
				? or(
						isNull(attachmentsTable.thread_id),
						notInArray(attachmentsTable.thread_id, EXCLUDED_THREAD_IDS),
					)
				: undefined
		if (excludeAttachments) attachmentConditions.push(excludeAttachments)

		// Over-fetched relative to `limit` because a message can carry several image
		// attachments: the previous `IN (SELECT ... LIMIT limit+1)` capped the
		// candidate *attachments*, so duplicates within that window collapsed and
		// the page came back short. Deduplicating first is what the subquery did
		// not do, and `cursorLimit` here is measured in distinct messages.
		const imageAttachments = await this.db
			.select({ message_id: attachmentsTable.message_id })
			.from(attachmentsTable)
			.where(and(...attachmentConditions))
			.orderBy(desc(attachmentsTable.created_at))
			.limit(cursorLimit(limit) * ATTACHMENT_ID_OVERSAMPLE)
		const imageMsgIds = [...new Set(imageAttachments.map((a) => a.message_id))]

		// Fetch full message rows for those IDs
		const rows = imageMsgIds.length
			? await this.db
					.select(messageWithVerdict)
					.from(messagesTable)
					.leftJoin(
						verdictsTable,
						eq(verdictsTable.message_id, messagesTable.id),
					)
					.where(inArray(messagesTable.id, imageMsgIds))
					.orderBy(desc(messagesTable.created_at))
					.limit(cursorLimit(limit))
			: []

		const data = rows
			.slice(0, limit)
			.map((r) => mapMessageRow(flattenVerdict(r)))
		const nextCursor = nextCursorAt(rows, limit)

		logger.debug({ count: data.length, nextCursor }, "Found image messages")
		return { data, nextCursor }
	}

	async getAttachmentsByChannel(
		channelId: string,
		query: MessageQuery,
	): Promise<PageResult<AttachmentResult>> {
		const limit = query.limit ?? 50
		const conditions: SQL[] = [eq(attachmentsTable.channel_id, channelId)]

		// Detail view: narrow to the selected message so we don't show
		// everyone else's images from the same channel.
		if (query.messageId) {
			conditions.push(eq(attachmentsTable.message_id, query.messageId))
		}

		if (query.cursor) {
			conditions.push(lt(attachmentsTable.created_at, Number(query.cursor)))
		}

		const rows = await this.db
			.select()
			.from(attachmentsTable)
			.where(and(...conditions))
			.orderBy(desc(attachmentsTable.created_at))
			.limit(cursorLimit(limit))

		const data = rows.map(mapAttachmentRow)

		// `nextCursorAt` reads the LAST RETURNED row (index `limit - 1`), not the
		// overflow row at index `limit`. An earlier comment here claimed index
		// `limit` "matches the other cursor-paginated queries" — it did, and that
		// was the bug in all of them: it skipped one row per page boundary. See
		// `nextCursorAt` for the full explanation.
		const nextCursor = nextCursorAt(rows, limit)
		const trimmed = data.slice(0, limit)

		return { data: trimmed, nextCursor }
	}

	/**
	 * Per-hour message volume for the last `days` days, grouped by channel.
	 * Powers the public Activity Heatmap (read-only, no write scope).
	 * Returns a flat list of { channel_id, hour (0-23), count } buckets.
	 */
	async getActivity(days = 30) {
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		// `EXTRACT(HOUR FROM to_timestamp(created_at / 1000))` resolved in the
		// database's timezone — see `localHour` for why UTC would be wrong here.
		const rows = await this.db
			.select({
				channel_id: messagesTable.channel_id,
				metadata: messagesTable.metadata,
				created_at: messagesTable.created_at,
			})
			.from(messagesTable)
			.where(gte(messagesTable.created_at, since))

		const buckets = new Map<string, { channelName: string; hours: number[] }>()
		for (const r of rows) {
			const channelName = readChannelName(r.metadata) ?? r.channel_id
			const hour = localHour(r.created_at)
			const entry = buckets.get(r.channel_id) ?? {
				channelName,
				hours: new Array(24).fill(0),
			}
			// A later row may carry the name when an earlier one did not.
			if (entry.channelName === r.channel_id && channelName !== r.channel_id) {
				entry.channelName = channelName
			}
			entry.hours[hour] += 1
			buckets.set(r.channel_id, entry)
		}

		return [...buckets.entries()]
			.flatMap(([channelId, v]) =>
				v.hours.map((count, hour) => ({
					channelId: channelId || "unknown",
					channelName: v.channelName || "unknown",
					hour,
					count,
				})),
			)
			.sort(
				(a, b) => a.channelName.localeCompare(b.channelName) || a.hour - b.hour,
			)
	}

	/**
	 * Recent message edits across the server (evasion-signal tracker).
	 * Public, read-only. Joins message_edits → messages for context.
	 *
	 * Cursor-paged on `(edited_at, id)`. Unlike the review queue this one really
	 * does sort by recency, so a single timestamp cursor would almost be enough —
	 * but `id` is the tiebreak for the same reason as everywhere else: two edits
	 * in the same millisecond would otherwise be returned in an arbitrary order
	 * and could be duplicated or dropped across a page boundary.
	 */
	async getRecentEdits(
		limit = 50,
		channelId?: string,
		cursor?: string,
	): Promise<EditPageResult> {
		const at = decodeEditCursor(cursor)

		// `message_edits.message_id` has no foreign key and so no Prisma relation,
		// so the previous INNER JOIN to `messages` becomes a keyed lookup. Ordering
		// is on `message_edits` columns alone, so the fetch needs no over-scan.
		// `message_edits` has no channel column and no foreign key, so a
		// channelId filter has to be resolved to message ids first. That lookup is
		// skipped when no channel was requested, which is the common case.
		let channelMessageIds: string[] | null = null
		if (channelId) {
			const inChannel = await this.db
				.select({ id: messagesTable.id })
				.from(messagesTable)
				.where(eq(messagesTable.channel_id, channelId))
			channelMessageIds = inChannel.map((m) => m.id)
			if (channelMessageIds.length === 0) {
				return { results: [], nextCursor: null }
			}
		}

		// The cursor replays the (edited_at, id) lexicographic comparison: strictly
		// older, OR same millisecond with a lower id.
		const conditions: SQL[] = []
		if (at) {
			conditions.push(
				anyOf(
					lt(messageEditsTable.edited_at, at.edited_at),
					allOf(
						eq(messageEditsTable.edited_at, at.edited_at),
						lt(messageEditsTable.id, at.id),
					),
				),
			)
		}
		if (channelMessageIds) {
			conditions.push(inArray(messageEditsTable.message_id, channelMessageIds))
		}

		const rows = await this.db
			.select({
				id: messageEditsTable.id,
				message_id: messageEditsTable.message_id,
				old_content: messageEditsTable.old_content,
				edited_at: messageEditsTable.edited_at,
			})
			.from(messageEditsTable)
			.where(and(...conditions))
			.orderBy(desc(messageEditsTable.edited_at), desc(messageEditsTable.id))
			.limit(cursorLimit(limit))

		const messageIds = [...new Set(rows.map((r) => r.message_id))]
		const contextById = new Map<
			string,
			{
				channel_id: string
				channel_name: string
				username: string
				new_content: string
			}
		>()
		if (messageIds.length > 0) {
			const msgs = await this.db
				.select({
					id: messagesTable.id,
					channel_id: messagesTable.channel_id,
					metadata: messagesTable.metadata,
					username: messagesTable.username,
					content: messagesTable.content,
					edited_content: messagesTable.edited_content,
				})
				.from(messagesTable)
				.where(inArray(messagesTable.id, messageIds))
			for (const m of msgs) {
				// An INNER JOIN dropped edits whose message is gone; `contextById`
				// reproduces that by filtering below rather than emitting a null row.
				contextById.set(m.id, {
					channel_id: m.channel_id,
					channel_name: readChannelName(m.metadata) ?? m.channel_id,
					username: m.username,
					new_content: m.edited_content ?? m.content,
				})
			}
		}

		// The `limit + 1`-th row is fetched purely to detect "there is more"; it is
		// not part of `results`. The cursor is built from the last RETURNED row
		// (index `limit - 1`) — see `nextCursorAt` for why index `limit` loses a
		// row per page boundary.
		const joined = rows
			.slice(0, limit)
			.map((r) => {
				const ctx = contextById.get(r.message_id)
				if (!ctx) return null
				return {
					id: String(r.id),
					message_id: String(r.message_id),
					old_content: r.old_content ? String(r.old_content) : "",
					new_content: ctx.new_content ? String(ctx.new_content) : "",
					edited_at: r.edited_at ? Number(r.edited_at) : 0,
					channel_id: ctx.channel_id ? String(ctx.channel_id) : null,
					channel_name: ctx.channel_name ? String(ctx.channel_name) : null,
					username: ctx.username ? String(ctx.username) : null,
				}
			})
			.filter((r): r is NonNullable<typeof r> => r !== null)

		const last = rows.length > limit ? rows[limit - 1] : undefined
		const nextCursor = last
			? encodeEditCursor({
					edited_at: Number(last.edited_at ?? 0),
					id: String(last.id),
				})
			: null

		return { results: joined, nextCursor }
	}

	/**
	 * Distinct guilds present in the message archive (drives the guild picker).
	 */
	async listGuilds(): Promise<
		Array<{ id: string; name: string; icon: string | null }>
	> {
		// `distinct: ["guild_id"]` becomes DISTINCT ON in SQL. The subquery keeps
		// `orderBy` honest: DISTINCT ON requires the ORDER BY to lead with the
		// distinct column, or Postgres rejects the query.
		const rows = await this.db
			.selectDistinct({ guild_id: messagesTable.guild_id })
			.from(messagesTable)
			.orderBy(asc(messagesTable.guild_id))
		return rows.map((row) => ({
			id: String(row.guild_id ?? ""),
			name: `Guild ${String(row.guild_id).slice(0, 8)}`,
			icon: null,
		}))
	}

	/**
	 * Text channels for a guild, derived from the message archive
	 * (drives the channel picker).
	 */
	async listTextChannels(
		guildId: string,
	): Promise<Array<{ id: string; name: string; type: "text" }>> {
		const rows = await this.db
			.selectDistinct({ channel_id: messagesTable.channel_id })
			.from(messagesTable)
			.where(eq(messagesTable.guild_id, guildId))
			.orderBy(asc(messagesTable.channel_id))
		return rows.map((row) => ({
			id: String(row.channel_id ?? ""),
			name: `Channel ${String(row.channel_id).slice(0, 8)}`,
			type: "text" as const,
		}))
	}
}
