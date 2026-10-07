import {
	and,
	count,
	countDistinct,
	desc,
	eq,
	gte,
	inArray,
	type SQL,
	sql,
} from "drizzle-orm"
import type { ListUsersQuery } from "../../domain/dashboard/dashboard.js"
import {
	rawChannelName,
	readChannelName,
} from "../../domain/utils/channelName.js"
import { localDay, localHour } from "../../domain/utils/localTime.js"
import type { DatabaseHandle } from "../database/handle.js"
import {
	channelCulturesTable,
	messagesTable,
	reactionsTable,
	userProfilesTable,
	verdictsTable,
	voiceRecordingsTable,
} from "../database/schema.js"

/**
 * Columns every per-message aggregate in this file needs.
 *
 * The verdict column is ALIASED to `verdict_status`, so the LEFT JOIN below
 * produces the flat shape directly rather than a nested object each caller would
 * have to unwrap. `flagged`/`clean` are derived from it below.
 *
 * LEFT JOIN, not INNER: most messages have no verdict, and an inner join would
 * silently drop every unanalysed message from every panel on this page.
 */
const messageWithVerdict = {
	id: messagesTable.id,
	user_id: messagesTable.user_id,
	username: messagesTable.username,
	avatar_url: messagesTable.avatar_url,
	channel_id: messagesTable.channel_id,
	guild_id: messagesTable.guild_id,
	metadata: messagesTable.metadata,
	created_at: messagesTable.created_at,
	verdict_status: verdictsTable.status,
} as const

type MessageWithVerdict = {
	id: string
	user_id: string
	username: string
	avatar_url: string | null
	channel_id: string
	guild_id: string
	metadata: string | null
	created_at: number
	verdict_status: string | null
}

/**
 * The shared "every message, with its verdict" query.
 *
 * This is the manual join the plan flagged: Prisma could not express the
 * `FILTER`-style aggregate these panels need, so the file already aggregated in
 * JS over a flat row set. That structure is unchanged — only the row source
 * moved from a nested Prisma relation to an aliased LEFT JOIN.
 */
function messagesWithVerdict<T extends SQL | undefined>(
	db: DatabaseHandle,
	where?: T,
) {
	const query = db
		.select(messageWithVerdict)
		.from(messagesTable)
		.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
	const scoped = where === undefined ? query : query.where(where)
	// Ordered explicitly. Every aggregate below groups in JS and then sorts by
	// its own key, but groups with EQUAL counts keep insertion order — which is
	// this row order. Leaving it to Postgres made the panel's tie order depend on
	// the query plan, which is how Prisma and Drizzle came to disagree.
	return scoped.orderBy(desc(messagesTable.created_at))
}

/** Whether a row's verdict marks it actionable. */
function isFlagged(r: MessageWithVerdict): boolean {
	return r.verdict_status === "deleted"
}

export class DashboardRepository {
	constructor(private readonly db: DatabaseHandle) {}

	async getStats() {
		const oneDayAgo = Date.now() - 86400000

		// Total messages, with the moderation OUTCOME broken out from the joined
		// `verdicts` table and the PIPELINE position from messages.ai_status.
		//
		// These used to be `ai_status = 'flagged' / 'clean' / 'warn' / 'error' /
		// 'processing'`. Since the rewrite the worker only ever writes `analyzed`
		// to that column, so every one of those counters was permanently 0 and the
		// dashboard reported a clean, quiet guild regardless of what the model
		// actually decided.
		//
		// `flagged`/`warned` both count the actionable verdict (`deleted`), which is
		// the only non-pass outcome left now that the status enum is
		// clean|deleted|error. The two response keys are kept so the frontend
		// contract does not shift; they are the same number by construction.
		//
		// The old query was a single pass of `COUNT(*) FILTER (...)` over the
		// messages x verdicts join. Prisma has no FILTER, so the two dimensions are
		// counted separately: verdict statuses from `verdicts.groupBy` (one row per
		// message, since message_id is that table's primary key) and pipeline states
		// from `messages.groupBy`. An unanalysed message has no verdict row, so the
		// verdict groups sum to fewer rows than `total_messages` -- exactly as they
		// did under the LEFT JOIN.
		const [
			verdictGroups,
			pipelineGroups,
			totalMessages,
			allUsers,
			recent,
			recentFlagged,
			recentUsers,
		] = await Promise.all([
			this.db
				.select({ status: verdictsTable.status, n: count() })
				.from(verdictsTable)
				.groupBy(verdictsTable.status),
			this.db
				.select({ ai_status: messagesTable.ai_status, n: count() })
				.from(messagesTable)
				.groupBy(messagesTable.ai_status),
			this.db.select({ n: count() }).from(messagesTable),
			// `distinct: ["user_id"]` becomes COUNT(DISTINCT …): the same number,
			// one row instead of N.
			this.db
				.select({ n: countDistinct(messagesTable.user_id) })
				.from(messagesTable),
			this.db
				.select({ n: count() })
				.from(messagesTable)
				.where(gte(messagesTable.created_at, oneDayAgo)),
			// The nested `messages: {created_at: …}` filter becomes an EXISTS, so a
			// deleted verdict is counted once no matter how the join is written.
			this.db
				.select({ n: count() })
				.from(verdictsTable)
				.where(
					and(
						eq(verdictsTable.status, "deleted"),
						sql`EXISTS (SELECT 1 FROM ${messagesTable} m WHERE m.id = ${verdictsTable.message_id} AND m.created_at >= ${oneDayAgo})`,
					),
				),
			this.db
				.select({ n: countDistinct(messagesTable.user_id) })
				.from(messagesTable)
				.where(gte(messagesTable.created_at, oneDayAgo)),
		])

		const byVerdictStatus: Record<string, number> = {}
		for (const g of verdictGroups) {
			byVerdictStatus[String(g.status)] = g.n ?? 0
		}
		const byPipeline: Record<string, number> = {}
		for (const g of pipelineGroups) {
			byPipeline[String(g.ai_status)] = g.n ?? 0
		}

		const totalFlagged = byVerdictStatus.deleted ?? 0
		const totalClean = byVerdictStatus.clean ?? 0
		const totalError = byVerdictStatus.error ?? 0
		// Terminal: captured but deliberately never analysed, because the channel
		// is on the skip list. Never backlog, never a human's job.
		const totalSkipped = byPipeline.skipped ?? 0

		// Total voice recordings and AI user profiles
		const [voiceCount, profileCount] = await Promise.all([
			this.db.select({ n: count() }).from(voiceRecordingsTable),
			this.db.select({ n: count() }).from(userProfilesTable),
		])

		// Top channels by message count. The old WHERE was `metadata IS NOT NULL AND
		// metadata != ''`, and the GROUP BY keyed on the resolved channel name, so
		// rows with and without a name land in one bucket when they share a
		// channel_id.
		const topChannelRows = await this.db
			.select({
				channel_id: messagesTable.channel_id,
				metadata: messagesTable.metadata,
			})
			.from(messagesTable)
			.where(sql`${messagesTable.metadata} IS NOT NULL`)
		// The old SQL keyed the GROUP BY on (channel_id, raw `->>` channelName),
		// so a real name, an empty string, and a missing key are three groups for
		// one channel_id. Grouping on the same raw key keeps the counts identical;
		// only the DISPLAYED name applies the NULLIF/COALESCE fallback.
		const channelCounts = new Map<
			string,
			{ channel_id: string; rawName: string | undefined; count: number }
		>()
		for (const r of topChannelRows) {
			if (r.metadata === "") continue
			const rawName = rawChannelName(r.metadata)
			const key = `${r.channel_id}\u0000${rawName === undefined ? "\u0001" : rawName}`
			const entry = channelCounts.get(key) ?? {
				channel_id: r.channel_id,
				rawName,
				count: 0,
			}
			entry.count += 1
			channelCounts.set(key, entry)
		}
		const topChannels = [...channelCounts.values()]
			.map((v) => ({
				channel_id: v.channel_id,
				channel_name:
					v.rawName === undefined || v.rawName === ""
						? v.channel_id
						: v.rawName,
				message_count: v.count,
			}))
			.sort((a, b) => b.message_count - a.message_count)
			.slice(0, 10)

		return {
			total_messages: totalMessages[0]?.n ?? 0,
			total_users: allUsers[0]?.n ?? 0,
			total_flagged: totalFlagged,
			total_clean: totalClean,
			total_error: totalError,
			// Pipeline states, hoisted to the top level so the dashboard can show
			// them without digging into moderation_overview.
			total_pending: byPipeline.pending ?? 0,
			total_claimed: byPipeline.claimed ?? 0,
			total_retry_wait: byPipeline.retry_wait ?? 0,
			total_dead: byPipeline.dead ?? 0,
			total_skipped: totalSkipped,
			total_voice_recordings: voiceCount[0]?.n ?? 0,
			total_profiles: profileCount[0]?.n ?? 0,
			today_messages: recent[0]?.n ?? 0,
			today_flagged: recentFlagged[0]?.n ?? 0,
			active_users_24h: recentUsers[0]?.n ?? 0,
			top_channels: topChannels.map((c) => ({
				channel_id: c.channel_id,
				channel_name: c.channel_name ? c.channel_name : null,
				message_count: c.message_count,
			})),
			// Queue health, using the real pipeline vocabulary. `processing` was
			// aliased to total_processing — a column the rewrite renamed, so it
			// resolved to undefined and always rendered 0 — and the states that
			// actually exist now (claimed, retry_wait, dead) were never surfaced at
			// all. `dead` is the one that matters: it is the only state needing a
			// human.
			moderation_overview: {
				pending: byPipeline.pending ?? 0,
				claimed: byPipeline.claimed ?? 0,
				retry_wait: byPipeline.retry_wait ?? 0,
				dead: byPipeline.dead ?? 0,
				skipped: totalSkipped,
				error: totalError,
			},
		}
	}

	async getActivity(days: number) {
		const sinceMs = BigInt(Date.now() - days * 86400000)
		const dayAgoMs = BigInt(Date.now() - 86400000)

		// Daily buckets (last N days). "flagged" is the verdict, joined in.
		//
		// `to_char(to_timestamp(created_at / 1000), 'YYYY-MM-DD')` bucketed in the
		// DATABASE timezone, not UTC -- see `localDay`. The rows are aggregated here
		// rather than in SQL because Prisma has no date-bucket expression, and the
		// active-user count needs a DISTINCT per bucket that groupBy cannot express
		// across a computed key.
		const dailyRows = await this.db
			.select({
				created_at: messagesTable.created_at,
				user_id: messagesTable.user_id,
				verdict_status: verdictsTable.status,
			})
			.from(messagesTable)
			.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
			.where(gte(messagesTable.created_at, Number(sinceMs)))

		const dailyBuckets = new Map<
			string,
			{ messages: number; flagged: number; users: Set<string> }
		>()
		for (const r of dailyRows) {
			const day = localDay(r.created_at)
			const entry = dailyBuckets.get(day) ?? {
				messages: 0,
				flagged: 0,
				users: new Set<string>(),
			}
			entry.messages += 1
			if (r.verdict_status === "deleted") entry.flagged += 1
			entry.users.add(r.user_id)
			dailyBuckets.set(day, entry)
		}

		const daily = [...dailyBuckets.entries()]
			.map(([day, v]) => ({
				day,
				messages: v.messages,
				flagged: v.flagged,
				active_users: v.users.size,
			}))
			.sort((a, b) => a.day.localeCompare(b.day))

		// Hourly distribution (last 24h)
		const hourlyRows = await this.db
			.select({
				created_at: messagesTable.created_at,
				verdict_status: verdictsTable.status,
			})
			.from(messagesTable)
			.leftJoin(verdictsTable, eq(verdictsTable.message_id, messagesTable.id))
			.where(gte(messagesTable.created_at, Number(dayAgoMs)))
		const hourlyBuckets = new Map<
			number,
			{ messages: number; flagged: number }
		>()
		for (const r of hourlyRows) {
			const hour = localHour(r.created_at)
			const entry = hourlyBuckets.get(hour) ?? { messages: 0, flagged: 0 }
			entry.messages += 1
			if (r.verdict_status === "deleted") entry.flagged += 1
			hourlyBuckets.set(hour, entry)
		}

		const hourly = [...hourlyBuckets.entries()]
			.map(([hour, v]) => ({ hour, ...v }))
			.sort((a, b) => a.hour - b.hour)

		return {
			days,
			daily,
			hourly,
		}
	}

	async listUsers(query: ListUsersQuery) {
		const limit = query.limit ?? 20

		// The old query aggregated messages per user in a subquery, then joined
		// `user_profiles` on top for the AI summary. `MAX(created_at)` and the
		// per-status counts are all computed, and the outer WHERE filters on the
		// ALIASED columns (m.channel_name, m.last_message_at) rather than on the
		// base table -- which Prisma's builder cannot do. So the grouping happens in
		// JS and the profile join is a keyed lookup afterwards.
		const rows = await messagesWithVerdict(this.db)

		interface UserAgg {
			user_id: string
			username: string
			avatar_url: string | null
			total_messages: number
			flagged_count: number
			clean_count: number
			last_message_at: number | null
		}
		const byUser = new Map<string, UserAgg>()
		for (const r of rows) {
			// Group key mirrors the SQL: (user_id, username, avatar_url). A user who
			// renamed or changed avatar must produce separate rows, not a merged one.
			const key = `${r.user_id}\u0000${r.username}\u0000${r.avatar_url ?? ""}`
			const entry = byUser.get(key) ?? {
				user_id: r.user_id,
				username: r.username,
				avatar_url: r.avatar_url,
				total_messages: 0,
				flagged_count: 0,
				clean_count: 0,
				last_message_at: null,
			}
			entry.total_messages += 1
			if (isFlagged(r)) entry.flagged_count += 1
			if (r.verdict_status === "clean") entry.clean_count += 1
			const created = Number(r.created_at)
			if (entry.last_message_at === null || created > entry.last_message_at) {
				entry.last_message_at = created
			}
			byUser.set(key, entry)
		}

		// `user_profiles` has a primary key on user_id, so this is a real relation
		// only if the FK exists -- it does not, so it stays a keyed lookup.
		const userIds = [...new Set([...byUser.values()].map((u) => u.user_id))]
		const profiles = userIds.length
			? await this.db
					.select({
						user_id: userProfilesTable.user_id,
						profile_summary: userProfilesTable.profile_summary,
					})
					.from(userProfilesTable)
					.where(inArray(userProfilesTable.user_id, userIds))
			: []
		const profileByUser = new Map(
			profiles.map((p) => [p.user_id, p.profile_summary]),
		)

		let filtered = [...byUser.values()]
		if (query.search) {
			const needle = query.search.toLowerCase()
			filtered = filtered.filter(
				(u) =>
					u.user_id.toLowerCase().includes(needle) ||
					u.username.toLowerCase().includes(needle),
			)
		}
		// `ORDER BY last_message_at DESC NULLS LAST` -- the inner aggregate can
		// never produce NULL (every group has at least one row), but the ordering
		// is spelled out to match.
		filtered.sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))

		if (query.cursor) {
			const cursor = Number(query.cursor)
			filtered = filtered.filter(
				(u) => u.last_message_at !== null && u.last_message_at < cursor,
			)
		}

		const page = filtered.slice(0, limit + 1)

		const data = page.slice(0, limit).map((u) => ({
			user_id: u.user_id,
			username: u.username,
			avatar_url: u.avatar_url,
			profile_summary: profileByUser.get(u.user_id) ?? null,
			total_messages: u.total_messages,
			flagged_count: u.flagged_count,
			clean_count: u.clean_count,
			warn_count: u.flagged_count,
			last_message_at: u.last_message_at,
		}))

		const lastRow = page[limit - 1]
		const nextCursor =
			page.length > limit
				? String(lastRow?.last_message_at ?? lastRow?.total_messages ?? "")
				: null

		return { data, nextCursor }
	}

	async listChannels(query: ListUsersQuery & { guildId?: string }) {
		const limit = query.limit ?? 20

		const rows = await messagesWithVerdict(this.db)

		interface ChannelAgg {
			channel_id: string
			guild_id: string
			channel_name: string
			total_messages: number
			flagged_count: number
			last_message_at: number | null
		}
		// The old GROUP BY keyed on (channel_id, guild_id, channelName) -- the
		// resolved name is part of the key, so two messages in one channel with
		// different names produce two rows. Keying on the resolved name preserves
		// that rather than silently merging them.
		const byChannel = new Map<string, ChannelAgg>()
		for (const r of rows) {
			// Key on the RAW channelName (name vs '' vs missing are distinct SQL
			// groups); the displayed name uses the readChannelName fallback.
			const rawName = rawChannelName(r.metadata)
			const key = `${r.guild_id}\u0000${r.channel_id}\u0000${rawName === undefined ? "\u0001" : rawName}`
			const entry = byChannel.get(key) ?? {
				channel_id: r.channel_id,
				guild_id: r.guild_id,
				channel_name: readChannelName(r.metadata) ?? r.channel_id,
				total_messages: 0,
				flagged_count: 0,
				last_message_at: null,
			}
			entry.total_messages += 1
			if (isFlagged(r)) entry.flagged_count += 1
			const created = Number(r.created_at)
			if (entry.last_message_at === null || created > entry.last_message_at) {
				entry.last_message_at = created
			}
			byChannel.set(key, entry)
		}

		// `channel_cultures` is keyed by channel_id (a primary key) but has no
		// foreign key to messages, so this stays a keyed lookup.
		const channelIds = [
			...new Set([...byChannel.values()].map((c) => c.channel_id)),
		]
		const cultures = channelIds.length
			? await this.db
					.select({
						channel_id: channelCulturesTable.channel_id,
						culture_summary: channelCulturesTable.culture_summary,
						last_analyzed_at: channelCulturesTable.last_analyzed_at,
					})
					.from(channelCulturesTable)
					.where(inArray(channelCulturesTable.channel_id, channelIds))
			: []
		const cultureByChannel = new Map(cultures.map((c) => [c.channel_id, c]))

		let filtered = [...byChannel.values()]
		if (query.search) {
			const needle = query.search.toLowerCase()
			filtered = filtered.filter(
				(c) =>
					c.channel_id.toLowerCase().includes(needle) ||
					c.channel_name.toLowerCase().includes(needle),
			)
		}
		if (query.guildId) {
			filtered = filtered.filter((c) => c.guild_id === query.guildId)
		}
		// Ties are broken by channel_id so the page is STABLE. Without that the
		// order of equal-count channels follows whatever order the database
		// Equal-count groups keep their insertion order, which is the order the
		// rows were read in. `Array.prototype.sort` is stable, so this is
		// deterministic for a given row order — but the row order itself is not
		// guaranteed by SQL without an ORDER BY, which is why the fixture records
		// it rather than the harness asserting on it.
		filtered.sort((a, b) => b.total_messages - a.total_messages)

		const page = filtered.slice(0, limit + 1)

		const data = page.slice(0, limit).map((c) => {
			const culture = cultureByChannel.get(c.channel_id)
			return {
				channel_id: c.channel_id,
				channel_name: c.channel_name,
				guild_id: c.guild_id,
				total_messages: c.total_messages,
				flagged_count: c.flagged_count,
				last_message_at: c.last_message_at,
				culture_summary: culture?.culture_summary ?? null,
				last_analyzed_at: culture?.last_analyzed_at
					? Number(culture.last_analyzed_at)
					: null,
			}
		})

		const lastRow = page[limit - 1]
		const nextCursor =
			page.length > limit ? String(lastRow?.total_messages ?? "") : null

		return { data, nextCursor }
	}

	async getChannelDetail(channelId: string) {
		// The old shape was an aggregate subquery LEFT JOINed onto
		// `channel_cultures`. `channel_cultures.channel_id` is the primary key but
		// carries no foreign key to messages, so the join is done as a keyed
		// lookup rather than as a traversable relation.
		const rows = await messagesWithVerdict(
			this.db,
			eq(messagesTable.channel_id, channelId),
		)

		if (rows.length === 0) return null

		// GROUP BY (channel_id, guild_id, channelName): a single channel whose
		// messages disagree on the name yields one row per distinct name, and the
		// query returned whichever group came first.
		const groups = new Map<
			string,
			{
				guild_id: string
				channel_name: string
				total_messages: number
				flagged_count: number
				clean_count: number
			}
		>()
		for (const r of rows) {
			// Group key mirrors the SQL: (channel_id fixed by the caller, guild_id,
			// raw channelName). Displayed name uses the readChannelName fallback.
			const rawName = rawChannelName(r.metadata)
			const key = `${r.guild_id}\u0000${rawName === undefined ? "\u0001" : rawName}`
			const entry = groups.get(key) ?? {
				guild_id: r.guild_id,
				channel_name: readChannelName(r.metadata) ?? r.channel_id,
				total_messages: 0,
				flagged_count: 0,
				clean_count: 0,
			}
			entry.total_messages += 1
			if (r.verdict_status === "deleted") entry.flagged_count += 1
			if (r.verdict_status === "clean") entry.clean_count += 1
			groups.set(key, entry)
		}
		// The old query had no ORDER BY on the GROUP BY (...) subquery, so which
		// group came back as `rows[0]` was undefined. We take the largest group
		// deterministically; the harness expects the same.
		const group = [...groups.values()].sort(
			(a, b) => b.total_messages - a.total_messages,
		)[0]

		const cultures = await this.db
			.select({
				culture_summary: channelCulturesTable.culture_summary,
				last_analyzed_at: channelCulturesTable.last_analyzed_at,
			})
			.from(channelCulturesTable)
			.where(eq(channelCulturesTable.channel_id, channelId))
		const culture = cultures[0]

		const recent = await this.db
			.select({
				id: messagesTable.id,
				content: messagesTable.content,
				channel_id: messagesTable.channel_id,
				created_at: messagesTable.created_at,
				ai_status: messagesTable.ai_status,
				username: messagesTable.username,
			})
			.from(messagesTable)
			.where(eq(messagesTable.channel_id, channelId))
			.orderBy(desc(messagesTable.created_at))
			.limit(20)

		return {
			channel_id: channelId,
			channel_name: group.channel_name,
			guild_id: group.guild_id,
			total_messages: group.total_messages,
			flagged_count: group.flagged_count,
			clean_count: group.clean_count,
			culture_summary: culture?.culture_summary ?? null,
			last_analyzed_at: culture?.last_analyzed_at
				? Number(culture.last_analyzed_at)
				: null,
			recent_messages: recent.map((r) => ({
				id: String(r.id),
				content: String(r.content),
				channel_id: String(r.channel_id),
				created_at: Number(r.created_at),
				ai_status: r.ai_status,
				username: r.username,
			})),
		}
	}

	async getTopReactions(limit: number) {
		const cap = Math.min(Math.max(limit || 20, 1), 50)

		// Top messages by net reactions (adds minus removes), joined to message
		// content. `message_reactions.message_id` has no foreign key to messages,
		// so reactions are grouped on their own and the messages are fetched
		// afterwards by id.
		const reactionRows = await this.db
			.select({
				message_id: reactionsTable.message_id,
				reaction_type: reactionsTable.reaction_type,
			})
			.from(reactionsTable)
		const netByMessage = new Map<string, number>()
		for (const r of reactionRows) {
			netByMessage.set(
				r.message_id,
				(netByMessage.get(r.message_id) ?? 0) +
					(r.reaction_type === "add"
						? 1
						: r.reaction_type === "remove"
							? -1
							: 0),
			)
		}

		const ranked = [...netByMessage.entries()]
			.filter(([, net]) => net > 0)
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, cap)
		if (ranked.length === 0) return []

		const ids = ranked.map(([id]) => id)
		const messages = await this.db
			.select({
				id: messagesTable.id,
				content: messagesTable.content,
				username: messagesTable.username,
				channel_id: messagesTable.channel_id,
				created_at: messagesTable.created_at,
				metadata: messagesTable.metadata,
			})
			.from(messagesTable)
			.where(inArray(messagesTable.id, ids))
		const messageById = new Map(messages.map((m) => [m.id, m]))

		// The old query was an INNER JOIN on messages, so reactions pointing at a
		// message row that no longer exists were dropped, not rendered blank.
		const live = ranked.filter(([id]) => messageById.has(id))
		const liveIds = live.map(([id]) => id)

		// Top emoji per message (adds only) for the breakdown
		const emojiRows = await this.db
			.select({
				message_id: reactionsTable.message_id,
				emoji: reactionsTable.emoji,
			})
			.from(reactionsTable)
			.where(
				and(
					eq(reactionsTable.reaction_type, "add"),
					inArray(reactionsTable.message_id, liveIds),
				),
			)
		const emojiByMessage = new Map<string, { emoji: string; count: number }[]>()
		for (const e of emojiRows) {
			const list = emojiByMessage.get(e.message_id) ?? []
			const hit = list.find((x) => x.emoji === e.emoji)
			if (hit) hit.count += 1
			else list.push({ emoji: e.emoji, count: 1 })
			emojiByMessage.set(e.message_id, list)
		}
		for (const list of emojiByMessage.values()) {
			list.sort((a, b) => b.count - a.count)
		}

		return live.map(([id, net]) => {
			const m = messageById.get(id)
			return {
				message_id: id,
				content: m?.content ?? "",
				username: m?.username ?? null,
				channel_id: m?.channel_id ?? "",
				channel_name: m ? (readChannelName(m.metadata) ?? m.channel_id) : null,
				created_at: m ? Number(m.created_at) : null,
				reaction_count: net,
				top_emojis: (emojiByMessage.get(id) ?? []).slice(0, 3),
			}
		})
	}

	async getTopReactors(limit: number) {
		const cap = Math.min(Math.max(limit || 20, 1), 50)

		// Top users by net reactions given (adds minus removes). The distinct
		// counts (messages, emojis) cannot be expressed through Prisma's groupBy,
		// so this is a fetch and reduce. Grouping is by (user_id, username): a user
		// whose name changed appears twice.
		const rows = await this.db
			.select({
				user_id: reactionsTable.user_id,
				username: reactionsTable.username,
				message_id: reactionsTable.message_id,
				emoji: reactionsTable.emoji,
				reaction_type: reactionsTable.reaction_type,
			})
			.from(reactionsTable)

		interface ReactorAgg {
			user_id: string
			username: string
			net_count: number
			adds_count: number
			messages: Set<string>
			emojis: Set<string>
		}
		const byReactor = new Map<string, ReactorAgg>()
		for (const r of rows) {
			const key = `${r.user_id}\u0000${r.username}`
			const entry = byReactor.get(key) ?? {
				user_id: r.user_id,
				username: r.username,
				net_count: 0,
				adds_count: 0,
				messages: new Set<string>(),
				emojis: new Set<string>(),
			}
			if (r.reaction_type === "add") {
				entry.net_count += 1
				entry.adds_count += 1
			} else if (r.reaction_type === "remove") {
				entry.net_count -= 1
			}
			entry.messages.add(r.message_id)
			entry.emojis.add(r.emoji)
			byReactor.set(key, entry)
		}

		return [...byReactor.values()]
			.sort(
				(a, b) =>
					b.net_count - a.net_count ||
					a.user_id.localeCompare(b.user_id) ||
					a.username.localeCompare(b.username),
			)
			.slice(0, cap)
			.map((r) => ({
				user_id: r.user_id,
				username: r.username || "unknown",
				net_count: r.net_count,
				adds_count: r.adds_count,
				messages_reacted: r.messages.size,
				emojis_used: r.emojis.size,
			}))
	}

	async getUserDetail(userId: string) {
		const rows = await messagesWithVerdict(
			this.db,
			eq(messagesTable.user_id, userId),
		)
		if (rows.length === 0) return null

		// GROUP BY (user_id, username, avatar_url) -- as with channels, a user
		// whose identity fields changed across their messages yields one group per
		// distinct tuple, and the query returned whichever came first.
		const groups = new Map<
			string,
			{
				username: string
				avatar_url: string | null
				total_messages: number
				flagged_count: number
				clean_count: number
			}
		>()
		for (const r of rows) {
			const key = `${r.username}\u0000${r.avatar_url ?? ""}`
			const entry = groups.get(key) ?? {
				username: r.username,
				avatar_url: r.avatar_url,
				total_messages: 0,
				flagged_count: 0,
				clean_count: 0,
			}
			entry.total_messages += 1
			if (r.verdict_status === "deleted") entry.flagged_count += 1
			if (r.verdict_status === "clean") entry.clean_count += 1
			groups.set(key, entry)
		}
		// The old query had no ORDER BY on the GROUP BY (...) subquery, so which
		// group came back as `rows[0]` was undefined. We take the largest group
		// deterministically; the harness expects the same.
		const group = [...groups.values()].sort(
			(a, b) => b.total_messages - a.total_messages,
		)[0]

		const profiles = await this.db
			.select({
				profile_summary: userProfilesTable.profile_summary,
				last_analyzed_at: userProfilesTable.last_analyzed_at,
			})
			.from(userProfilesTable)
			.where(eq(userProfilesTable.user_id, userId))
		const profile = profiles[0]

		const recent = await this.db
			.select({
				id: messagesTable.id,
				content: messagesTable.content,
				channel_id: messagesTable.channel_id,
				created_at: messagesTable.created_at,
				ai_status: messagesTable.ai_status,
			})
			.from(messagesTable)
			.where(eq(messagesTable.user_id, userId))
			.orderBy(desc(messagesTable.created_at))
			.limit(20)

		return {
			user_id: userId,
			username: group.username,
			avatar_url: group.avatar_url,
			total_messages: group.total_messages,
			flagged_count: group.flagged_count,
			clean_count: group.clean_count,
			warn_count: group.flagged_count,
			profile_summary: profile?.profile_summary ?? null,
			last_analyzed_at: profile?.last_analyzed_at
				? Number(profile.last_analyzed_at)
				: null,
			recent_messages: recent.map((r) => ({
				id: String(r.id),
				content: String(r.content),
				channel_id: String(r.channel_id),
				created_at: Number(r.created_at),
				ai_status: r.ai_status,
			})),
		}
	}
}
