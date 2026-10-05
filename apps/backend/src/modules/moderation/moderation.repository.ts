import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm"
import { getDatabase } from "../../shared/database/drizzle.js"
import {
	analysisAttemptsTable,
	messagesTable,
	moderationActionsTable,
	verdictsTable,
} from "../../shared/database/schema.js"
import { readChannelName } from "../../shared/utils/channelName.js"
import { localHour } from "../../shared/utils/localTime.js"

export interface ListModerationQuery {
	status?: string
	actionType?: string
	limit?: number
	cursor?: number
}

const ACTION_TYPES = ["delete_message", "reset_nickname"] as const
const STATUSES = ["pending", "executed", "failed"] as const

/**
 * Normalize `moderation_actions.categories` to a list of categories.
 *
 * The column is `text` and has been written in at least two different shapes:
 *
 *   1. `["gambling","scam"]`  — a JSON array (the current writer)
 *   2. `harassment`            — a bare category, or a comma list like
 *      `inappropriate_content, spam` (the older writer)
 *
 * 172 of 1403 live rows are shape 2. Every `::jsonb` cast on this column
 * therefore aborts the whole query, not just the offending row, which is why
 * `moderation/trends` and `moderation/byCategory` returned 500 rather than
 * skipping the bad row.
 *
 * This mirrors the cast-free SQL expression it replaces, which was built from
 * `regexp_matches` and `regexp_split_to_array` precisely so that no input,
 * however malformed, could raise "invalid input syntax for type json":
 *
 *   - Quoted tokens are preferred, so a JSON-array row yields its members
 *     rather than the whole `["a","b"]` string.
 *   - Otherwise the raw value is split on commas.
 *   - An empty/blank cell yields no categories, never `['']`.
 *
 * The adversarial cases the SQL was verified against are preserved as tests.
 */
export function normalizeCategories(raw: string | null | undefined): string[] {
	if (!raw) return []

	// Quoted tokens win, mirroring `array_agg(DISTINCT t[1])` taking precedence.
	const quoted = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1])
	const tokens =
		quoted.length > 0
			? quoted
			: raw
					.trim()
					.split(/\s*,\s*/)
					.filter((t) => t.length > 0)

	return [...new Set(tokens)]
}

/** Parse a JSON-stringified array column (e.g. flags/categories/evidence).
 *  Returns null on empty/malformed input so the FE can treat it as "no data". */
function parseJsonArray(value: unknown): string[] | null {
	if (value == null) return null
	const str = typeof value === "string" ? value : String(value)
	if (str.length === 0) return null
	try {
		const parsed = JSON.parse(str)
		return Array.isArray(parsed) ? (parsed as string[]) : null
	} catch {
		return null
	}
}

export class ModerationRepository {
	/**
	 * Headline moderation counts.
	 *
	 * This used to aggregate `moderation_actions`, the gateway's auto-delete log.
	 * The rewrite removed gateway-side enforcement — deletion and DMs are now the
	 * backend's job — so nothing writes that table any more and it is frozen at
	 * the moment of the cutover. Counting it produced a dashboard that looked
	 * static while moderation was in fact working.
	 *
	 * The live signal is `verdicts` (what the model decided) joined to `messages`
	 * (where each message sits in the pipeline). `executed`/`failed` are kept in
	 * the response so the frontend contract does not change, but they now mean
	 * "actionable vs errored verdict" rather than "action succeeded".
	 */
	async getStats() {
		const db = getDatabase()
		// Grouped by `status` alone. This used to also group by
		// `v.recommended_action`, but that was a second copy of the same decision:
		// it could only be 'clean' or 'deleted', so every group was already
		// determined by the status sitting beside it, and a disagreement between
		// them would only have split one verdict across two buckets. `status` is
		// the decision; `reason` is the explanation and does not belong in a count.
		// Messages with no verdict at all are the `unjudged` bucket. Prisma's
		// groupBy cannot coalesce a NULL from a left join, so those rows are
		// counted separately rather than as part of the grouped verdict statuses.
		const [byVerdictStatus, unjudgedRows] = await Promise.all([
			// `groupBy` is a plain aggregate in Drizzle: select the grouping column
			// alongside `count(*)`. Prisma's `{_count: {_all: true}}` shape has no
			// equivalent, so the row count comes straight from SQL COUNT.
			db
				.select({ status: verdictsTable.status, n: count() })
				.from(verdictsTable)
				.groupBy(verdictsTable.status),
			// `verdicts.message_id` is the primary key, so "no verdict" is exactly a
			// LEFT JOIN miss. `NOT EXISTS` says that in one pass; Prisma spelled it
			// `{verdicts: {is: null}}`.
			db
				.select({ n: count() })
				.from(messagesTable)
				.where(
					sql`NOT EXISTS (SELECT 1 FROM ${verdictsTable} v WHERE v.message_id = ${messagesTable.id})`,
				),
		])

		let executed = 0 // verdicts that call for action
		let failed = 0 // errored verdicts
		let pending = 0 // nothing concluded yet

		const byStatus: Record<string, number> = {}

		for (const r of byVerdictStatus) {
			const status = String(r.status ?? "unjudged")
			const n = r.n
			byStatus[status] = (byStatus[status] ?? 0) + n

			if (status === "error") {
				failed += n
			} else if (status === "unjudged") {
				pending += n
			} else {
				executed += n
			}
		}

		const unjudged = unjudgedRows[0]?.n ?? 0
		if (unjudged > 0) {
			byStatus.unjudged = (byStatus.unjudged ?? 0) + unjudged
			pending += unjudged
		}

		const total = executed + failed + pending

		return {
			total,
			executed,
			failed,
			pending,
			failed_rate: total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0,
			by_status: byStatus,
		}
	}

	/**
	 * Queue health from `messages` alone: how much work is outstanding, and how
	 * much of it has been abandoned. `dead` is the only number here that needs a
	 * human — everything else resolves on its own.
	 */
	async getQueueStats() {
		const db = getDatabase()
		const groups = await db
			.select({ ai_status: messagesTable.ai_status, n: count() })
			.from(messagesTable)
			.where(
				or(
					ne(messagesTable.ai_status, "analyzed"),
					isNotNull(messagesTable.deleted_at),
				),
			)
			.groupBy(messagesTable.ai_status)
		const byStatus: Record<string, number> = {}
		for (const r of groups) byStatus[String(r.ai_status)] = r.n
		return {
			by_status: byStatus,
			pending: byStatus.pending ?? 0,
			claimed: byStatus.claimed ?? 0,
			retry_wait: byStatus.retry_wait ?? 0,
			dead: byStatus.dead ?? 0,
			// Terminal like `analyzed`, so it stays out of every "outstanding
			// work" number above. Reported on its own so an operator can see that
			// the skip list is actually taking effect.
			skipped: byStatus.skipped ?? 0,
		}
	}

	async listActions(query: ListModerationQuery) {
		const db = getDatabase()
		const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)

		// The where-clause is built with the query builder rather than by
		// concatenating into SQL text. The two enum-ish filters are still checked
		// against their allow-lists first, so an unknown value is ignored rather
		// than forwarded — and Drizzle binds every value as a parameter, so nothing
		// is spliced into the statement either way.
		const conditions: SQL[] = []

		if (
			query.status &&
			(STATUSES as readonly string[]).includes(query.status)
		) {
			// `status` is declared as a pg enum in the schema, so Drizzle narrows the
			// accepted values to the union. The allow-list check above already proved
			// this is one of them; the cast just re-states that to the type system.
			conditions.push(
				eq(
					moderationActionsTable.status,
					query.status as (typeof STATUSES)[number],
				),
			)
		}
		if (
			query.actionType &&
			(ACTION_TYPES as readonly string[]).includes(query.actionType)
		) {
			conditions.push(
				eq(
					moderationActionsTable.action_type,
					query.actionType as (typeof ACTION_TYPES)[number],
				),
			)
		}
		if (query.cursor) {
			// `created_at` is epoch milliseconds held as a number, not a timestamp.
			conditions.push(
				lt(moderationActionsTable.created_at, Number(query.cursor)),
			)
		}

		// `limit + 1` rows are fetched so the extra row, if present, is the
		// existence proof for `nextCursor` without a second COUNT query.
		const rows = await db
			.select()
			.from(moderationActionsTable)
			.where(and(...conditions))
			.orderBy(desc(moderationActionsTable.created_at))
			.limit(limit + 1)

		// `moderation_actions.message_id` has no foreign key, so there is no
		// relation to traverse; the previous LEFT JOIN to `messages` is reproduced
		// as an explicit keyed lookup. Only the ids on this page are fetched, which
		// bounds the second query to at most `limit + 1` keys.
		const messageIds = [
			...new Set(
				rows.map((r) => r.message_id).filter((id): id is string => !!id),
			),
		]
		const contents = new Map<string, string>()
		if (messageIds.length > 0) {
			const msgs = await db
				.select({ id: messagesTable.id, content: messagesTable.content })
				.from(messagesTable)
				.where(inArray(messagesTable.id, messageIds))
			for (const m of msgs) contents.set(m.id, m.content)
		}

		const data = rows.slice(0, limit).map((r) => ({
			id: String(r.id ?? ""),
			message_id: r.message_id ? String(r.message_id) : null,
			user_id: r.user_id ? String(r.user_id) : null,
			guild_id: String(r.guild_id ?? ""),
			action_type: String(r.action_type ?? "unknown"),
			reason: r.reason ? String(r.reason) : null,
			executed_by: r.executed_by ? String(r.executed_by) : null,
			status: String(r.status ?? "unknown"),
			error: r.error ? String(r.error) : null,
			created_at: r.created_at ? Number(r.created_at) : null,
			executed_at: r.executed_at ? Number(r.executed_at) : null,
			flags: parseJsonArray(r.flags),
			categories: parseJsonArray(r.categories),
			confidence: r.confidence != null ? Number(r.confidence) : null,
			score: r.score != null ? Number(r.score) : null,
			evidence: parseJsonArray(r.evidence),
			policy_version: r.policy_version ? String(r.policy_version) : null,
			username: r.username ? String(r.username) : null,
			server_nick: r.server_nick ? String(r.server_nick) : null,
			// Truncated in SQL previously via LEFT(m.content, 300); Prisma has no
			// column-substring operator, so the cut happens here.
			content:
				r.message_id && contents.has(r.message_id)
					? (contents.get(r.message_id) as string).slice(0, 300)
					: null,
		}))

		const lastRow = rows[limit - 1]
		const nextCursor =
			rows.length > limit && lastRow?.created_at
				? String(Number(lastRow.created_at))
				: null

		return { data, nextCursor }
	}

	/**
	 * Aggregate moderation trends over the last `days` days.
	 * - category counts (from the jsonb/text[] `categories` column, unnested)
	 * - decision distribution (ranked: what was decided, by action_type)
	 * - action_type distribution
	 * Read-only; powers the public Toxic Topic Trends panel.
	 *
	 * This panel used to chart a `severity` distribution. Severity is gone, and
	 * nothing took its place on `moderation_actions` — that table has no decision
	 * column, only `action_type` (what was done) and `status` (pending/executed/
	 * failed).
	 *
	 * It returns BOTH `decisions` and `actions`, and they are deliberately not the
	 * same thing: `decisions` is `action_type` with a force-ranked CASE order
	 * (delete_message > reset_nickname), because `desc()` on a text enum sorts
	 * lexically and would present that as the ranking. `actions` is the plain
	 * count-descending breakdown. The dashboard's ranked panel reads `actions`, so
	 * neither key is dead and dropping either one empties a chart.
	 *
	 * There are exactly two action types. `mute_user` / `warn_user` /
	 * `kick_user` / `ban_user` were aspirational labels that nothing ever wrote
	 * and that prod has zero rows of; they are gone rather than left as filters
	 * that could only ever return an empty table.
	 */
	async getTrends(days: number) {
		const db = getDatabase()
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		const CAT_LIMIT = 15

		// Categories are normalized in JS rather than via `unnest` in SQL: the
		// column holds two storage shapes (see normalizeCategories), and the
		// cross-shape dedup plus "top 15" ordering is cheaper to express here
		// than to emulate through the query builder.
		const catRows = await db
			.select({ categories: moderationActionsTable.categories })
			.from(moderationActionsTable)
			.where(
				and(
					gte(moderationActionsTable.created_at, since),
					ne(moderationActionsTable.categories, ""),
				),
			)

		// A `not: null` test cannot be expressed on an optional scalar in the
		// typed filter, so NULL rows are dropped after the fetch — `normalizeCategories`
		// already returns an empty list for them, so no category can leak through.

		const catCounts = new Map<string, number>()
		for (const row of catRows) {
			for (const cat of normalizeCategories(row.categories)) {
				if (cat === "") continue
				catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1)
			}
		}
		const topCategories = [...catCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
			.slice(0, CAT_LIMIT) as { name: string; count: number }[]

		// Ranked by the DECISION, because a bare `GROUP BY action_type` returns rows in
		// an arbitrary order that is not a ranking. `action_type` is a text enum, so
		// it needs the explicit CASE — `desc()` on it directly would sort lexically
		// ("reset_nickname" > "delete_message"), which is not the order of force
		// the action represents. Count breaks ties within a decision.
		// `action_type` is declared NOT NULL in the schema, so the old
		// `action_type IS NOT NULL` guard has no counterpart here and is dropped.
		// Both `decisions` and `actions` below read the SAME grouped rows. Prisma
		// ran the identical `groupBy` twice; there is no reason to pay for the
		// round trip twice, and one result set feeds both rankings.
		const actGroups = await db
			.select({ action_type: moderationActionsTable.action_type, n: count() })
			.from(moderationActionsTable)
			.where(gte(moderationActionsTable.created_at, since))
			.groupBy(moderationActionsTable.action_type)

		// Ranked by the DECISION, because a bare `GROUP BY action_type` returns rows in
		// an arbitrary order that is not a ranking. `action_type` is a text enum, so
		// it needs the explicit CASE — ordering on it directly would sort lexically
		// ("reset_nickname" > "delete_message"), which is not the order of force
		// the action represents. Count breaks ties within a decision.
		const decisionRank = (t: string) =>
			t === "delete_message" ? 1 : t === "reset_nickname" ? 0 : -1

		const decisions = actGroups
			.map((g) => ({ level: String(g.action_type), count: g.n }))
			.sort(
				(a, b) =>
					decisionRank(b.level) - decisionRank(a.level) ||
					b.count - a.count ||
					a.level.localeCompare(b.level),
			)

		const actions = actGroups
			.map((g) => ({ type: String(g.action_type), count: g.n }))
			.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))

		return {
			categories: topCategories,
			decisions,
			actions,
		}
	}

	/**
	 * Top flagged domains over the last `days` days.
	 * Extracts the host from any URL in the message content / reason / evidence
	 * and ranks by how often it appears in moderation actions.
	 *
	 * `moderation_actions` has no `content` column — the message body only lives
	 * on `messages`, so the text is read through the same
	 * `LEFT JOIN messages` that `listActions` and `getByCategory` use. Querying
	 * `a.content` directly raised "column a.content does not exist", i.e. a 500
	 * on every call.
	 */
	async getTopFlaggedDomains(days: number) {
		const db = getDatabase()
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		const actions = await db
			.select({
				id: moderationActionsTable.id,
				message_id: moderationActionsTable.message_id,
				reason: moderationActionsTable.reason,
				evidence: moderationActionsTable.evidence,
			})
			.from(moderationActionsTable)
			.where(
				and(
					gte(moderationActionsTable.created_at, since),
					or(
						isNotNull(moderationActionsTable.reason),
						isNotNull(moderationActionsTable.evidence),
						isNotNull(moderationActionsTable.message_id),
					),
				),
			)

		// The previous query joined to `messages` and read `m.content`. That
		// content is fetched per batch of message ids rather than joined, because
		// `moderation_actions.message_id` has no foreign key and so no relation to
		// traverse.
		const messageIds = [
			...new Set(
				actions.map((a) => a.message_id).filter((id): id is string => !!id),
			),
		]
		const contents = new Map<string, string>()
		if (messageIds.length > 0) {
			const msgs = await db
				.select({ id: messagesTable.id, content: messagesTable.content })
				.from(messagesTable)
				.where(inArray(messagesTable.id, messageIds))
			for (const m of msgs) contents.set(m.id, m.content)
		}

		// Hosts are extracted with the same regex the SQL used
		// (https?://([^/\s?#]+)), and DISTINCT-per-action is preserved by the Set:
		// one action mentioning a host three times counted once.
		const HOST_RE = /https?:\/\/([^/\s?#]+)/g
		const hostCounts = new Map<string, number>()
		for (const a of actions) {
			const text = [
				a.message_id ? (contents.get(a.message_id) ?? "") : "",
				a.reason ?? "",
				a.evidence ?? "",
			].join(" ")
			if (text.trim() === "") continue
			const seen = new Set<string>()
			for (const m of text.matchAll(HOST_RE)) seen.add(m[1].toLowerCase())
			for (const host of seen)
				hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)
		}

		return [...hostCounts.entries()]
			.map(([domain, count]) => ({ domain, count }))
			.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
			.slice(0, 20)
	}

	/**
	 * Top flagged channels over the last `days` days.
	 * Joins moderation_actions → messages to attribute each action to a channel.
	 * Powers the Top Flagged Channels panel.
	 */
	async getTopFlaggedChannels(days: number) {
		const db = getDatabase()
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		const actions = await db
			.select({ message_id: moderationActionsTable.message_id })
			.from(moderationActionsTable)
			.where(
				and(
					gte(moderationActionsTable.created_at, since),
					isNotNull(moderationActionsTable.message_id),
				),
			)

		const messageIds = [
			...new Set(
				actions.map((a) => a.message_id).filter((id): id is string => !!id),
			),
		]

		// One message can carry several moderation actions, so the metric counts
		// ACTIONS per channel, not distinct messages. The previous query joined
		// actions→messages and `COUNT(*)`-ed the join, which double-counts any
		// message with more than one action; iterating `actions` here reproduces
		// that exactly (and the comparison harness guards it).
		//
		// `metadata` is a JSON column, so the channel name is read in JS rather
		// than through a `->>` path expression, which the query builder has no
		// equivalent for.
		const channelOfMessage = new Map<string, { id: string; name?: string }>()
		if (messageIds.length > 0) {
			const msgs = await db
				.select({
					id: messagesTable.id,
					channel_id: messagesTable.channel_id,
					metadata: messagesTable.metadata,
				})
				.from(messagesTable)
				.where(
					and(
						inArray(messagesTable.id, messageIds),
						ne(messagesTable.channel_id, ""),
					),
				)
			for (const m of msgs) {
				channelOfMessage.set(m.id, {
					id: m.channel_id as string,
					name: readChannelName(m.metadata),
				})
			}
		}

		const byChannel = new Map<
			string,
			{ name: string | undefined; count: number }
		>()
		for (const a of actions) {
			const info = a.message_id ? channelOfMessage.get(a.message_id) : undefined
			if (!info) continue // LEFT JOIN semantics: no channel -> not counted
			const entry = byChannel.get(info.id) ?? { name: info.name, count: 0 }
			// A later row may carry the name when an earlier one did not.
			if (!entry.name && info.name) entry.name = info.name
			entry.count += 1
			byChannel.set(info.id, entry)
		}

		return [...byChannel.entries()]
			.map(([channel_id, v]) => ({
				channel_id,
				channel_name: v.name ?? null,
				flagged_count: v.count,
			}))
			.sort(
				(a, b) =>
					b.flagged_count - a.flagged_count ||
					a.channel_id.localeCompare(b.channel_id),
			)
			.slice(0, 15)
	}

	/**
	 * Hour-of-day distribution of moderation actions over the last `days` days.
	 * 24 rows (hour 0..23), with a total count per hour.
	 * Powers the Moderation Heatmap by Hour panel.
	 */
	async getHourlyModeration(days: number) {
		const db = getDatabase()
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		// `created_at` is epoch milliseconds. The hour-of-day is derived via
		// `localHour`, which resolves in the database's timezone — see that helper
		// for why UTC would be wrong here.
		const rows = await db
			.select({ created_at: moderationActionsTable.created_at })
			.from(moderationActionsTable)
			.where(gte(moderationActionsTable.created_at, since))

		const byHour = new Map<number, number>()
		for (const r of rows) {
			const hour = localHour(r.created_at)
			byHour.set(hour, (byHour.get(hour) ?? 0) + 1)
		}

		return Array.from({ length: 24 }, (_, h) => ({
			hour: h,
			total: byHour.get(h) ?? 0,
		}))
	}

	/**
	 * Moderation actions filtered to a single category (drill-down).
	 * Powers the Flag Category Drill-down panel.
	 *
	 * Uses the cast-free `CATEGORIES_TXT_ARRAY` normalizer, so a category that
	 * was written as a bare string (`harassment`) is matched just like one
	 * written as a JSON array (`["harassment"]`). Previously the
	 * `categories::jsonb` containment test made this procedure 500 for the whole
	 * table as soon as ANY row used the bare shape.
	 */
	async getByCategory(days: number, category: string, limit = 50) {
		const db = getDatabase()
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		const candidates = await db
			.select()
			.from(moderationActionsTable)
			.where(gte(moderationActionsTable.created_at, since))
			.orderBy(desc(moderationActionsTable.created_at))

		// The containment test (`normalizer(...) @> ARRAY[category]`) becomes a
		// membership check against the normalized list, which matches rows in
		// either storage shape. Rows are filtered before `limit` is applied, so the
		// page is the first N matches rather than the first N candidates.
		const matched = candidates
			.filter((a) => normalizeCategories(a.categories).includes(category))
			.slice(0, limit)

		const messageIds = [
			...new Set(
				matched.map((r) => r.message_id).filter((id): id is string => !!id),
			),
		]
		const contents = new Map<string, string>()
		if (messageIds.length > 0) {
			const msgs = await db
				.select({ id: messagesTable.id, content: messagesTable.content })
				.from(messagesTable)
				.where(inArray(messagesTable.id, messageIds))
			for (const m of msgs) contents.set(m.id, m.content)
		}

		return matched.map((r) => ({
			id: String(r.id ?? ""),
			message_id: r.message_id ? String(r.message_id) : null,
			user_id: r.user_id ? String(r.user_id) : null,
			guild_id: String(r.guild_id ?? ""),
			action_type: String(r.action_type ?? "unknown"),
			reason: r.reason ? String(r.reason) : null,
			status: String(r.status ?? "unknown"),
			created_at: r.created_at ? Number(r.created_at) : null,
			confidence: r.confidence != null ? Number(r.confidence) : null,
			score: r.score != null ? Number(r.score) : null,
			username: r.username ? String(r.username) : null,
			server_nick: r.server_nick ? String(r.server_nick) : null,
			content:
				r.message_id && contents.has(r.message_id)
					? (contents.get(r.message_id) as string).slice(0, 300)
					: null,
		}))
	}

	/**
	 * Auto-moderation coverage over the last `days` days.
	 * Attempt success rate from `analysis_attempts` — what fraction of model
	 * calls produced a usable verdict. Public "how much is automated" trust
	 * metric.
	 *
	 * This read `ai_analysis_runs`, which the rewrite dropped: it was written by
	 * the old in-process pipeline and has been permanently empty since, so the
	 * dashboard showed 0% coverage while the worker was in fact running fine.
	 * `analysis_attempts` is append-only and records every attempt — successful
	 * or not — which makes it the honest denominator.
	 */
	async getCoverage(days: number) {
		const db = getDatabase()
		const since = Date.now() - days * 24 * 60 * 60 * 1000

		const [attempts, pendingRows] = await Promise.all([
			db
				.select({ outcome: analysisAttemptsTable.outcome, n: count() })
				.from(analysisAttemptsTable)
				.where(gte(analysisAttemptsTable.created_at, since))
				.groupBy(analysisAttemptsTable.outcome),
			// Work still owed: claimed by a worker, or waiting out a retry backoff.
			db
				.select({ n: count() })
				.from(messagesTable)
				.where(
					and(
						inArray(messagesTable.ai_status, [
							"pending",
							"claimed",
							"retry_wait",
						]),
						gte(messagesTable.created_at, since),
					),
				),
		])

		const counts: Record<string, number> = {}
		let total = 0
		for (const r of attempts) {
			counts[String(r.outcome)] = r.n
			total += r.n
		}
		// "Failed" is anything the worker could not turn into a verdict. `duplicate`
		// is not a failure — the model answered fine, we just discarded a stale
		// result — so it counts as a success here.
		const completed = (counts.success ?? 0) + (counts.duplicate ?? 0)
		const failed =
			(counts.llm_error ?? 0) +
			(counts.parse_error ?? 0) +
			(counts.abandoned ?? 0)
		const pending = pendingRows[0]?.n ?? 0
		return {
			total,
			completed,
			failed,
			pending,
			// Counts are also exposed per-outcome so the UI can break down
			// parse failures separately from model timeouts.
			outcomes: counts,
			coverage_rate:
				total > 0 ? Number(((completed / total) * 100).toFixed(1)) : 0,
			failed_rate: total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0,
		}
	}
}

export const moderationRepository = new ModerationRepository()
