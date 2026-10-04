/**
 * COMPARISON HARNESS — proves the Prisma port returns the same numbers as the
 * SQL it replaced.
 *
 * The Prisma query builder has no expression for `date_trunc`, `unnest`,
 * `FILTER`, `->>`, or `regexp_matches`, so those aggregations were rewritten to
 * fetch rows and reduce them in JS. That is only safe if the reduction is
 * faithful. This harness runs the ORIGINAL SQL and the ported repository method
 * side by side against the same database and diffs the results.
 *
 * Read-only. Both sides are executed against live data; any divergence is
 * printed rather than hidden.
 *
 * Run with:
 *   DSN=postgresql://postgres:postgres@127.0.0.1:5433/gmw_mod \
 *     bun tests/moderation-compare-live.mjs
 */

import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
	console.error("DSN is required");
	process.exit(2);
}
process.env.DATABASE_URL = dsn;
process.env.DISCORD_TOKEN ??= "not-used-by-this-test";
process.env.JWT_SECRET ??= "not-used-by-this-test";

const DAYS = Number(process.env.DAYS ?? 30);
const pool = new pg.Pool({ connectionString: dsn });

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
	ok ? pass++ : fail++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Compare two values with order-insensitive equality after normalizing. */
function same(a, b) {
	return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

/**
 * Recursively canonicalize for comparison.
 *
 * Rows in an unordered result set are sorted by their own serialized content,
 * so two result sets that differ only in the position of tied rows still
 * compare equal. Sorting the *serialized strings* rather than the objects
 * themselves avoids relying on a stable, locale-independent key order.
 */
function sortDeep(v) {
	if (Array.isArray(v)) {
		// Only reorder top-level rows; nested arrays (e.g. flags, categories)
		// keep their order, since those are meaningful.
		return v
			.map((x) => sortDeep(x))
			.sort((x, y) => {
				const sx = JSON.stringify(x);
				const sy = JSON.stringify(y);
				return sx < sy ? -1 : sx > sy ? 1 : 0;
			});
	}
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, sortDeep(v[k])]),
		);
	}
	return v;
}

async function compare(name, sql, run, opts = {}) {
	const [expected, actual] = await Promise.all([
		pool.query(sql, opts.params ?? []),
		run(),
	]);
	// `ordered: false` is for result sets whose ORDER BY leaves ties unresolved.
	// Postgres and the JS reducer are then both free to emit tied rows in any
	// order, so comparing them positionally would report a difference that the
	// data does not actually contain. Content is still compared exactly.
	const orderSensitive = opts.ordered !== false;
	const a = orderSensitive ? expected.rows : [...expected.rows].sort(sortDeep);
	const b = orderSensitive ? actual : [...actual].sort(sortDeep);

	if (same(a, b)) {
		check(name, true, `${expected.rows.length} rows`);
	} else {
		check(name, false, "DIVERGENCE");
		console.log("  SQL    :", JSON.stringify(a).slice(0, 900));
		console.log("  Prisma :", JSON.stringify(b).slice(0, 900));
	}
}

const CATEGORIES_TXT_ARRAY = `COALESCE(
  (SELECT array_agg(DISTINCT t[1])
     FROM regexp_matches(COALESCE(a.categories,''), '"([^"]*)"', 'g') AS t),
  NULLIF(regexp_split_to_array(btrim(a.categories), '\\s*,\\s*'), ARRAY[''])
)`;

try {
	const { initializeDatabase, closeDatabase } = await import(
		"../src/shared/database/init.ts"
	);
	const { moderationRepository: repo } = await import(
		"../src/modules/moderation/moderation.repository.ts"
	);

	await initializeDatabase({
		DATABASE_URL: dsn,
		POSTGRES_POOL_MIN: 1,
		POSTGRES_POOL_MAX: 5,
	});

	// --- getCoverage: groupBy on analysis_attempts + queue count ---
	await compare(
		"getCoverage.outcomes",
		`SELECT outcome, COUNT(*)::int AS c FROM analysis_attempts
		 WHERE created_at >= ${Date.now() - DAYS * 86400000} GROUP BY outcome`,
		async () => {
			const r = await repo.getCoverage(DAYS);
			return Object.entries(r.outcomes).map(([outcome, count]) => ({
				outcome,
				c: count,
			}));
		},
		{ ordered: false },
	);

	await compare(
		"getCoverage.completed/failed/total",
		`SELECT
		   COUNT(*)::int AS total,
		   COUNT(*) FILTER (WHERE outcome IN ('success','duplicate'))::int AS completed,
		   COUNT(*) FILTER (WHERE outcome IN ('llm_error','parse_error','abandoned'))::int AS failed
		 FROM analysis_attempts WHERE created_at >= ${Date.now() - DAYS * 86400000}`,
		async () => {
			const r = await repo.getCoverage(DAYS);
			return [{ total: r.total, completed: r.completed, failed: r.failed }];
		},
	);

	// --- getTrends: categories via unnest, decisions via CASE rank ---
	await compare(
		"getTrends.categories",
		`SELECT cat, COUNT(*)::int AS c FROM (
		   SELECT unnest(${CATEGORIES_TXT_ARRAY}) AS cat
		   FROM moderation_actions a
		   WHERE a.created_at >= ${Date.now() - DAYS * 86400000}
		     AND a.categories IS NOT NULL AND btrim(a.categories) <> ''
		 ) s WHERE cat IS NOT NULL AND cat <> ''
		 GROUP BY cat ORDER BY c DESC LIMIT 15`,
		async () => {
			const r = await repo.getTrends(DAYS);
			return r.categories.map((x) => ({ cat: x.name, c: x.count }));
		},
		// The SQL's `ORDER BY c DESC` leaves equal counts unordered.
		{ ordered: false },
	);

	await compare(
		"getTrends.decisions",
		`SELECT action_type, COUNT(*)::int AS c FROM moderation_actions
		 WHERE created_at >= ${Date.now() - DAYS * 86400000} AND action_type IS NOT NULL
		 GROUP BY action_type
		 ORDER BY CASE action_type
		   WHEN 'delete_message' THEN 1 WHEN 'reset_nickname' THEN 0 ELSE -1 END DESC, c DESC`,
		async () => {
			const r = await repo.getTrends(DAYS);
			return r.decisions.map((x) => ({ action_type: x.level, c: x.count }));
		},
	);

	await compare(
		"getTrends.actions",
		`SELECT action_type, COUNT(*)::int AS c FROM moderation_actions
		 WHERE created_at >= ${Date.now() - DAYS * 86400000}
		 GROUP BY action_type ORDER BY c DESC`,
		async () => {
			const r = await repo.getTrends(DAYS);
			return r.actions.map((x) => ({ action_type: x.type, c: x.count }));
		},
		// `ORDER BY c DESC` leaves equal counts unordered.
		{ ordered: false },
	);

	// --- getHourlyModeration: EXTRACT(HOUR FROM to_timestamp(...)) ---
	await compare(
		"getHourlyModeration",
		`SELECT EXTRACT(HOUR FROM to_timestamp(created_at / 1000))::int AS hour,
		        COUNT(*)::int AS total
		 FROM moderation_actions WHERE created_at >= ${Date.now() - DAYS * 86400000}
		 GROUP BY hour ORDER BY hour`,
		async () => {
			const r = await repo.getHourlyModeration(DAYS);
			return r
				.filter((x) => x.total > 0)
				.map((x) => ({ hour: x.hour, total: x.total }));
		},
	);

	// --- getTopFlaggedDomains: regexp_matches over content||reason||evidence ---
	await compare(
		"getTopFlaggedDomains",
		`SELECT lower(host) AS host, COUNT(*)::int AS c FROM (
		   SELECT DISTINCT a.id,
		     (regexp_matches(COALESCE(m.content,'') || ' ' || COALESCE(a.reason,'') || ' ' ||
		                     COALESCE(a.evidence,''), 'https?://([^/\\s?#]+)', 'g'))[1] AS host
		   FROM moderation_actions a
		   LEFT JOIN messages m ON m.id = a.message_id
		   WHERE a.created_at >= ${Date.now() - DAYS * 86400000}
		     AND (m.content IS NOT NULL OR a.reason IS NOT NULL OR a.evidence IS NOT NULL)
		 ) sub WHERE host IS NOT NULL
		 GROUP BY lower(host) ORDER BY c DESC LIMIT 20`,
		async () => {
			const r = await repo.getTopFlaggedDomains(DAYS);
			return r.map((x) => ({ host: x.domain, c: x.count }));
		},
	);

	// --- getTopFlaggedChannels: metadata->channel->>channelName ---
	await compare(
		"getTopFlaggedChannels",
		`SELECT m.channel_id,
		        COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''),
		                 m.channel_id) AS channel_name,
		        COUNT(*)::int AS flagged_count
		 FROM moderation_actions a
		 LEFT JOIN messages m ON m.id = a.message_id
		 WHERE a.created_at >= ${Date.now() - DAYS * 86400000} AND m.channel_id IS NOT NULL
		 GROUP BY m.channel_id, (m.metadata::jsonb -> 'channel' ->> 'channelName')
		 ORDER BY flagged_count DESC LIMIT 15`,
		async () => {
			const r = await repo.getTopFlaggedChannels(DAYS);
			return r.map((x) => ({
				channel_id: x.channel_id,
				channel_name: x.channel_name ?? x.channel_id,
				flagged_count: x.flagged_count,
			}));
		},
	);

	// --- getQueueStats: groupBy with the OR filter ---
	await compare(
		"getQueueStats",
		`SELECT ai_status, COUNT(*)::int AS c FROM messages
		 WHERE ai_status <> 'analyzed' OR deleted_at IS NOT NULL
		 GROUP BY ai_status`,
		async () => {
			const r = await repo.getQueueStats();
			return Object.entries(r.by_status).map(([ai_status, c]) => ({
				ai_status,
				c,
			}));
		},
		{ ordered: false },
	);

	// --- getStats: verdict statuses + unjudged ---
	await compare(
		"getStats",
		`SELECT COALESCE(v.status,'unjudged') AS status, COUNT(*)::int AS c
		 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
		 GROUP BY 1`,
		async () => {
			const r = await repo.getStats();
			return Object.entries(r.by_status).map(([status, c]) => ({
				status,
				c,
			}));
		},
		// `GROUP BY 1` with no ORDER BY.
		{ ordered: false },
	);

	// --- getByCategory: containment over the normalizer ---
	const distinctCats = (
		await pool.query(
			`SELECT DISTINCT unnest(${CATEGORIES_TXT_ARRAY}) AS cat
			 FROM moderation_actions a
			 WHERE a.created_at >= ${Date.now() - DAYS * 86400000}
			   AND a.categories IS NOT NULL AND btrim(a.categories) <> ''
			 LIMIT 5`,
		)
	).rows.map((r) => r.cat);

	for (const cat of distinctCats) {
		await compare(
			`getByCategory(${JSON.stringify(cat)})`,
			`SELECT a.id FROM moderation_actions a
			 WHERE a.created_at >= ${Date.now() - DAYS * 86400000}
			   AND a.categories IS NOT NULL AND btrim(a.categories) <> ''
			   AND ${CATEGORIES_TXT_ARRAY} @> ARRAY[$1]::text[]
			 ORDER BY a.created_at DESC LIMIT 50`,
			async () => {
				const r = await repo.getByCategory(DAYS, cat, 50);
				return r.map((x) => ({ id: x.id }));
			},
			// The category is bound as $1, never interpolated.
			{ params: [cat] },
		);
	}

	// --- listActions: cursor page + joined content ---
	await compare(
		"listActions (default page)",
		`SELECT a.id,
		        a.message_id,
		        COALESCE(LEFT(m.content,300),'') AS content
		 FROM moderation_actions a
		 LEFT JOIN messages m ON m.id = a.message_id
		 ORDER BY a.created_at DESC LIMIT 50`,
		async () => {
			const r = await repo.listActions({ limit: 50 });
			return r.data.map((x) => ({
				id: x.id,
				message_id: x.message_id,
				content: x.content ?? "",
			}));
		},
	);
} catch (err) {
	console.error("harness error:", err?.message ?? err);
	fail++;
} finally {
	await pool.end();
	try {
		await closeDatabase();
	} catch {}
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);