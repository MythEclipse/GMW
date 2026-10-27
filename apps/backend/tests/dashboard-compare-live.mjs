/**
 * COMPARISON HARNESS — proves the Prisma port of
 * modules/dashboard/dashboard.repository.ts returns the same rows as the SQL
 * it replaced.
 *
 * The ports replace SQL `GROUP BY` / `FILTER` / `COUNT(DISTINCT …)` with
 * Map-and-Set reductions in JS, so a subtle difference in grouping keys is
 * exactly the kind of bug that still looks right on tidy data. The fixtures
 * carry the cases that break a naive loop:
 *
 *   * rename / avatar changes that MUST split a user's group, not merge it
 *   * reactions with a NET count of 0 and of negative — both filtered by > 0
 *   * rows whose channelName is empty-string vs missing vs a real name
 *   * reactions for messages that do not exist (the old JOIN dropped them)
 *
 * One caveat, stated so the numbers are readable: `messages.metadata` is
 * `text`, and the JSON path is identical, so the channel-name fallback
 * resolves the same as the SQL COALESCE.
 *
 * Run with:
 *   DSN=postgresql://postgres:postgres@127.0.0.1:5433/gmw_compare \
 *     bun tests/dashboard-compare-live.mjs
 */

import pg from "pg"

const dsn = process.env.DSN
if (!dsn) {
	console.error("DSN is required")
	process.exit(2)
}
process.env.DATABASE_URL = dsn
process.env.DISCORD_TOKEN ??= "not-used-by-this-test"
process.env.AI_LLM_API_KEY ??= "not-used-by-this-test"

const pool = new pg.Pool({ connectionString: dsn })

let pass = 0
let fail = 0

function check(name, ok, detail = "") {
	ok ? pass++ : fail++
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

function canonical(v) {
	if (Array.isArray(v)) return v.map(canonical)
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, canonical(v[k])]),
		)
	}
	if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v)
	return v
}
const same = (a, b) =>
	JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** Compare a SQL result's rows against the JS port's rows. */
async function compare(
	name,
	sql,
	run,
	{ unordered = false, params = [] } = {},
) {
	const [expectedResult, actual] = await Promise.all([
		pool.query(sql, params),
		run(),
	])
	let a = expectedResult.rows
	let b = actual
	if (unordered) {
		const key = (x) => JSON.stringify(canonical(x))
		a = [...a].sort((x, y) => (key(x) < key(y) ? -1 : 1))
		b = [...b].sort((x, y) => (key(x) < key(y) ? -1 : 1))
	}
	if (same(a, b)) {
		check(name, true, `${a.length} rows`)
	} else {
		check(name, false, "DIVERGENCE")
		console.log("  SQL    :", JSON.stringify(a).slice(0, 900))
		console.log("  Prisma :", JSON.stringify(b).slice(0, 900))
	}
}

// Imported OUTSIDE the try: the `finally` below calls `closeDrizzleDatabase`,
// and a binding declared inside `try` is not in scope there — the call threw a
// ReferenceError into an empty catch, so the pool was never closed.
const { initializeDatabase, getDatabase, closeDrizzleDatabase } = await import(
	"../src/infrastructure/database/drizzle.ts"
)
const { DashboardRepository } = await import(
	"../src/infrastructure/repositories/dashboard.repository.ts"
)

try {
	await initializeDatabase()
	const repo = new DashboardRepository(getDatabase())

	// --- getActivity ----------------------------------------------------
	await compare(
		"getActivity daily buckets",
		`SELECT to_char(to_timestamp(m.created_at / 1000), 'YYYY-MM-DD') AS day,
                        COUNT(*)::int AS messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged,
                        COUNT(DISTINCT m.user_id)::int AS active_users
                 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
                 WHERE m.created_at >= ${Date.now()} - (7 * 86400000)
                 GROUP BY day ORDER BY day`,
		async () => {
			const a = await repo.getActivity(7)
			return a.daily.map((d) => ({
				day: d.day,
				messages: d.messages,
				flagged: d.flagged,
				active_users: d.active_users,
			}))
		},
	)

	await compare(
		"getActivity hourly buckets",
		`SELECT EXTRACT(HOUR FROM to_timestamp(m.created_at / 1000))::int AS hour,
                        COUNT(*)::int AS messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged
                 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
                 WHERE m.created_at >= ${Date.now()} - 86400000
                 GROUP BY hour ORDER BY hour`,
		async () => {
			const a = await repo.getActivity(7)
			return a.hourly.map((h) => ({
				hour: h.hour,
				messages: h.messages,
				flagged: h.flagged,
			}))
		},
	)

	// --- getTopReactions -----------------------------------------------
	await compare(
		"getTopReactions net reactions",
		`SELECT m.id AS message_id, m.content, m.username, m.channel_id, r.reaction_count
                 FROM (
                   SELECT message_id,
                          (COUNT(*) FILTER (WHERE reaction_type = 'add')
                           - COUNT(*) FILTER (WHERE reaction_type = 'remove'))::int AS reaction_count
                   FROM message_reactions
                   GROUP BY message_id
                 ) r
                 JOIN messages m ON m.id = r.message_id
                 WHERE r.reaction_count > 0
                 ORDER BY r.reaction_count DESC, m.id ASC
                 LIMIT 20`,
		async () => {
			const r = await repo.getTopReactions(20)
			return r.map((x) => ({
				message_id: x.message_id,
				content: x.content,
				username: x.username,
				channel_id: x.channel_id,
				reaction_count: x.reaction_count,
			}))
		},
	)

	// --- getTopReactors ------------------------------------------------
	await compare(
		"getTopReactors net given",
		`SELECT user_id, username,
                        (COUNT(*) FILTER (WHERE reaction_type = 'add')
                         - COUNT(*) FILTER (WHERE reaction_type = 'remove'))::int AS net_count,
                        COUNT(*) FILTER (WHERE reaction_type = 'add')::int AS adds_count,
                        COUNT(DISTINCT message_id)::int AS messages_reacted,
                        COUNT(DISTINCT emoji)::int AS emojis_used
                 FROM message_reactions
                 GROUP BY user_id, username
                 ORDER BY net_count DESC, user_id ASC, username ASC
                 LIMIT 20`,
		async () => {
			const r = await repo.getTopReactors(20)
			return r.map((x) => ({
				user_id: x.user_id,
				username: x.username,
				net_count: x.net_count,
				adds_count: x.adds_count,
				messages_reacted: x.messages_reacted,
				emojis_used: x.emojis_used,
			}))
		},
	)

	// --- getStats: totals line ------------------------------------------
	await compare(
		"getStats totals line",
		`SELECT COUNT(*)::int AS total_messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS total_flagged,
                        COUNT(*) FILTER (WHERE v.status = 'clean')::int AS total_clean,
                        COUNT(*) FILTER (WHERE v.status = 'error')::int AS total_error,
                        COUNT(*) FILTER (WHERE m.ai_status = 'pending')::int AS total_pending,
                        COUNT(*) FILTER (WHERE m.ai_status = 'claimed')::int AS total_claimed,
                        COUNT(*) FILTER (WHERE m.ai_status = 'retry_wait')::int AS total_retry_wait,
                        COUNT(*) FILTER (WHERE m.ai_status = 'dead')::int AS total_dead,
                        COUNT(*) FILTER (WHERE m.ai_status = 'skipped')::int AS total_skipped,
                        COUNT(DISTINCT m.user_id)::int AS total_users,
                        COUNT(*) FILTER (WHERE m.created_at >= ${Date.now()} - 86400000)::int AS today_messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted' AND m.created_at >= ${Date.now()} - 86400000)::int AS today_flagged,
                        COUNT(DISTINCT m.user_id) FILTER (WHERE m.created_at >= ${Date.now()} - 86400000)::int AS active_users_24h
                 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id`,
		async () => {
			const s = await repo.getStats()
			return [
				{
					total_messages: s.total_messages,
					total_flagged: s.total_flagged,
					total_clean: s.total_clean,
					total_error: s.total_error,
					total_pending: s.total_pending,
					total_claimed: s.total_claimed,
					total_retry_wait: s.total_retry_wait,
					total_dead: s.total_dead,
					total_skipped: s.total_skipped,
					total_users: s.total_users,
					today_messages: s.today_messages,
					today_flagged: s.today_flagged,
					active_users_24h: s.active_users_24h,
				},
			]
		},
	)

	// --- getStats: top channels ------------------------------------------
	await compare(
		"getStats top_channels",
		`SELECT channel_id,
                        COALESCE(NULLIF((metadata::jsonb -> 'channel' ->> 'channelName'), ''), channel_id) AS channel_name,
                        COUNT(*)::int AS message_count
                 FROM messages
                 WHERE metadata IS NOT NULL AND metadata != ''
                 GROUP BY channel_id, (metadata::jsonb -> 'channel' ->> 'channelName')
                 ORDER BY COUNT(*) DESC
                 LIMIT 10`,
		async () => {
			const s = await repo.getStats()
			return s.top_channels
		},
		{ unordered: true },
	)
} catch (err) {
	console.error("harness error:", err?.message ?? err)
	fail++
} finally {
	await pool.end()
	try {
		await closeDrizzleDatabase()
	} catch {}
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
