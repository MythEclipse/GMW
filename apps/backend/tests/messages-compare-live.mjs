/**
 * COMPARISON HARNESS — proves the Prisma port of messages.repository.ts returns
 * the same rows, in the same order, as the SQL it replaced.
 *
 * The dangerous part of this file is `getReviewMessages`: its sort key is a
 * computed expression (CASE rank, FLOOR(score*100)) that Prisma's `orderBy`
 * cannot hold, so both the sort and the cursor filter moved into JS. A wrong
 * port still looks right on tidy data, so the fixtures deliberately include
 * scores that TIE under `floor(score*100)` while differing as raw floats — the
 * case where sorting on the raw column reverses the intended order.
 *
 * Read-only. Divergences are printed, not hidden.
 *
 * Run with:
 *   DSN=postgresql://postgres:postgres@127.0.0.1:5433/gmw_compare \
 *     bun tests/messages-compare-live.mjs
 */

import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
	console.error("DSN is required");
	process.exit(2);
}
process.env.DATABASE_URL = dsn;

const pool = new pg.Pool({ connectionString: dsn });

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
	ok ? pass++ : fail++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Canonicalize for comparison.
 *
 * `pg` returns `bigint` columns as STRINGS (to avoid precision loss) while
 * Prisma returns `number`. Every repository method normalizes these to number
 * before returning, so the harness must too or it compares `"123"` against
 * `123` and reports a divergence that the API contract does not have.
 */
function canonical(v) {
	if (Array.isArray(v)) return v.map(canonical);
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, canonical(v[k])]),
		);
	}
	// bigint columns come back from pg as strings; coerce numeric strings.
	if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
	return v;
}

const same = (a, b) =>
	JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Ordered comparison: row order is part of the contract for these queries. */
async function compareOrdered(
	name,
	sql,
	run,
	params = [],
	opts = {},
) {
	const [expected, actual] = await Promise.all([
		pool.query(sql, params),
		run(),
	]);
	let a = expected.rows;
	let b = actual;
	// `unordered` is for queries whose ORDER BY leaves ties unresolved. Postgres
	// and the JS path are then both free to emit tied rows in any order, so
	// comparing positionally would report a difference the data does not have.
	if (opts.unordered) {
		const key = (x) => JSON.stringify(canonical(x));
		a = [...a].sort((x, y) => (key(x) < key(y) ? -1 : 1));
		b = [...b].sort((x, y) => (key(x) < key(y) ? -1 : 1));
	}
	if (same(a, b)) {
		check(name, true, `${a.length} rows`);
	} else {
		check(name, false, "DIVERGENCE");
		console.log("  SQL    :", JSON.stringify(a).slice(0, 1100));
		console.log("  Prisma :", JSON.stringify(b).slice(0, 1100));
	}
}

const VERDICT_COLS = `
  v.status AS verdict_status, v.score AS verdict_score,
  v.confidence AS verdict_confidence, v.flags AS verdict_flags,
  v.categories AS verdict_categories, v.reason AS verdict_reason,
  v.analysis AS verdict_analysis, v.evidence AS verdict_evidence,
  v.model AS verdict_model, v.updated_at AS verdict_updated_at,
  v.auto_delete_state`;

try {
	const { initializeDatabase, closeDatabase } = await import(
		"../src/shared/database/init.ts"
	);
	const { messagesRepository: repo } = await import(
		"../src/modules/messages/messages.repository.ts"
	);

	await initializeDatabase({
		DATABASE_URL: dsn,
		POSTGRES_POOL_MIN: 1,
		POSTGRES_POOL_MAX: 5,
	});

	// --- findMany: no filters ------------------------------------------------
	await compareOrdered(
		"findMany (unfiltered page)",
		`SELECT m.id, m.created_at, v.status AS verdict_status, v.score AS verdict_score,
		        v.flags AS verdict_flags, v.reason AS verdict_reason, v.model AS verdict_model
		 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
		 ORDER BY m.created_at DESC LIMIT 10`,
		async () => {
			const r = await repo.findMany({ limit: 10 });
			return r.data.map((m) => ({
				id: m.id,
				created_at: m.created_at,
				verdict_status: m.verdict_status,
				verdict_score: m.verdict_score,
				verdict_flags: m.verdict_flags,
				verdict_reason: m.verdict_reason,
				verdict_model: m.verdict_model,
			}));
		},
		[],
		// `ORDER BY created_at DESC` with no tiebreak; the fixtures repeat
		// timestamps on purpose, so tied rows may come back in either order.
		{ unordered: true },
	);

	// --- findMany: verdict filter (joins through `verdicts`) -----------------
	for (const verdict of ["deleted", "clean", "error"]) {
		await compareOrdered(
			`findMany (verdict=${verdict})`,
			`SELECT m.id, m.created_at FROM messages m
			 LEFT JOIN verdicts v ON v.message_id = m.id
			 WHERE v.status = $1 ORDER BY m.created_at DESC LIMIT 10`,
			async () => {
				const r = await repo.findMany({ verdict, limit: 10 });
				return r.data.map((m) => ({ id: m.id, created_at: m.created_at }));
			},
			[verdict],
			{ unordered: true },
		);
	}

	// --- findMany: guild + channel + user + status ---------------------------
	await compareOrdered(
		"findMany (guild+channel+user+status)",
		`SELECT m.id, m.created_at FROM messages m
		 WHERE m.guild_id = 'g1' AND m.channel_id = 'ch1'
		   AND m.user_id = 'u1' AND m.ai_status = 'pending'
		 ORDER BY m.created_at DESC LIMIT 10`,
		async () => {
			const r = await repo.findMany({
				guildId: "g1",
				channelId: "ch1",
				userId: "u1",
				status: "pending",
				limit: 10,
			});
			return r.data.map((m) => ({ id: m.id, created_at: m.created_at }));
		},
	);

	// --- findById ------------------------------------------------------------
	await compareOrdered(
		"findById (judged)",
		`SELECT m.id, v.status AS verdict_status FROM messages m
		 LEFT JOIN verdicts v ON v.message_id = m.id WHERE m.id = 'm0005'`,
		async () => {
			const m = await repo.findById("m0005");
			return m ? [{ id: m.id, verdict_status: m.verdict_status }] : [];
		},
	);

	// --- cursor paging: walk every page and compare the concatenation --------
	{
		const sqlPage = async (cursor) => {
			const r = await pool.query(
				`SELECT m.id, m.created_at FROM messages m
				 ${cursor ? "WHERE m.created_at < $1" : ""}
				 ORDER BY m.created_at DESC LIMIT 6`,
				cursor ? [cursor] : [],
			);
			return r.rows;
		};
		const sqlIds = [];
		let c;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const page = await sqlPage(c);
			if (page.length === 0) break;
			sqlIds.push(...page.slice(0, 5).map((x) => x.id));
			if (page.length <= 5) break;
			c = String(page[4].created_at);
		}

		const prismaIds = [];
		c = undefined;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const r = await repo.findMany({ limit: 5, cursor: c });
			prismaIds.push(...r.data.map((m) => m.id));
			if (!r.nextCursor) break;
			c = r.nextCursor;
		}
		check(
			"findMany (full cursor walk, no dupes/skips)",
			same(sqlIds, prismaIds) &&
				new Set(prismaIds).size === prismaIds.length,
			`${prismaIds.length} ids`,
		);
		if (!same(sqlIds, prismaIds)) {
			console.log("  SQL    :", sqlIds.join(","));
			console.log("  Prisma :", prismaIds.join(","));
		}
	}

	// --- getReviewMessages: ORDER and CURSOR must both match -----------------
	{
		const sqlAll = await pool.query(`
			SELECT m.id, m.created_at, v.status, v.score
			FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
			WHERE v.status = 'deleted' OR m.ai_status = 'dead'
			ORDER BY
			  CASE v.status WHEN 'deleted' THEN 2 WHEN 'clean' THEN 1 ELSE 0 END DESC,
			  FLOOR(COALESCE(v.score, 0)::float8 * 100)::int DESC,
			  m.created_at DESC,
			  m.id DESC`);

		const expectedOrder = sqlAll.rows.map((r) => r.id);

		// Page through the port with a small limit so the cursor filter runs.
		const prismaOrder = [];
		let cursor;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const r = await repo.getReviewMessages(undefined, 3, cursor);
			prismaOrder.push(...r.results.map((x) => String(x.id)));
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}

		const orderOk = same(expectedOrder, prismaOrder);
		check(
			"getReviewMessages (full order matches SQL)",
			orderOk,
			`${prismaOrder.length} rows`,
		);
		if (!orderOk) {
			console.log("  SQL    :", expectedOrder.join(","));
			console.log("  Prisma :", prismaOrder.join(","));
		}
		check(
			"getReviewMessages (no duplicate rows across pages)",
			new Set(prismaOrder).size === prismaOrder.length,
		);

		// The score key must be the scaled integer, not the raw float. These two
		// rows tie at floor(*100)=50 but differ as floats, so ordering by the
		// raw column would flip them relative to created_at.
		const tieCheck = await pool.query(`
			SELECT count(*)::int AS n FROM verdicts
			WHERE score IS NOT NULL AND FLOOR(score*100) = 50 AND score <> 0.5`);
		check(
			"getReviewMessages (fixtures contain the float-tie trap)",
			tieCheck.rows[0].n > 0,
			`${tieCheck.rows[0].n} rows tie under floor(*100)`,
		);
	}

	// --- getReviewMessages: channel filter -----------------------------------
	{
		const sql = await pool.query(`
			SELECT m.id FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
			WHERE (v.status = 'deleted' OR m.ai_status = 'dead') AND m.channel_id = 'ch2'
			ORDER BY
			  CASE v.status WHEN 'deleted' THEN 2 WHEN 'clean' THEN 1 ELSE 0 END DESC,
			  FLOOR(COALESCE(v.score, 0)::float8 * 100)::int DESC,
			  m.created_at DESC, m.id DESC`);
		const r = await repo.getReviewMessages("ch2", 50);
		check(
			"getReviewMessages (channelId=ch2)",
			same(
				sql.rows.map((x) => x.id),
				r.results.map((x) => String(x.id)),
			),
			`${sql.rows.length} rows`,
		);
	}

	// --- getActivity ---------------------------------------------------------
	await compareOrdered(
		"getActivity",
		`SELECT m.channel_id,
		        COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''), m.channel_id) AS channel_name,
		        EXTRACT(HOUR FROM to_timestamp(m.created_at / 1000))::int AS hour,
		        COUNT(*)::int AS c
		 FROM messages m
		 WHERE m.created_at >= ${Date.now() - 86400000}
		 GROUP BY m.channel_id, channel_name, hour
		 ORDER BY channel_name, hour`,
		async () => {
			const r = await repo.getActivity(1);
			// Collapse the 24 buckets the port emits per channel into the
			// non-zero ones, matching what the GROUP BY would return.
			return r
				.filter((x) => x.count > 0)
				.map((x) => ({
					channel_id: x.channelId,
					channel_name: x.channelName,
					hour: x.hour,
					c: x.count,
				}));
		},
	);

	// --- getImageMessages ----------------------------------------------------
	// The repository returns `limit` rows; the +1 is the internal overflow
	// proof. So the SQL side is trimmed to `limit` too, otherwise it is
	// compared against a page plus a sentinel it never returns.
	await compareOrdered(
		"getImageMessages",
		`SELECT m.id FROM messages m
		 WHERE m.id IN (
		   SELECT a.message_id FROM attachments a WHERE a.guild_id = 'g1' AND a.type LIKE 'image/%'
		 )
		 ORDER BY m.created_at DESC LIMIT 10`,
		async () => {
			const r = await repo.getImageMessages("g1", 10);
			return r.data.map((m) => ({ id: m.id }));
		},
		[],
		// Ties on created_at again; neither side adds an id tiebreak here.
		{ unordered: true },
	);

	// --- getAttachmentsByChannel ---------------------------------------------
	await compareOrdered(
		"getAttachmentsByChannel",
		`SELECT a.id, a.message_id, a.created_at FROM attachments a
		 WHERE a.channel_id = 'ch1' ORDER BY a.created_at DESC LIMIT 10`,
		async () => {
			const r = await repo.getAttachmentsByChannel("ch1", { limit: 10 });
			return r.data.map((a) => ({
				id: a.id,
				message_id: a.message_id,
				created_at: a.created_at,
			}));
		},
	);

	// --- getRecentEdits ------------------------------------------------------
	await compareOrdered(
		"getRecentEdits",
		`SELECT e.id, e.message_id, e.old_content, e.edited_at, m.channel_id,
		        COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''), m.channel_id) AS channel_name,
		        m.username, COALESCE(m.edited_content, m.content) AS new_content
		 FROM message_edits e JOIN messages m ON m.id = e.message_id
		 ORDER BY e.edited_at DESC, e.id DESC LIMIT 10`,
		async () => {
			const r = await repo.getRecentEdits(10);
			return r.results;
		},
	);

	// --- getRecentEdits: channel filter + full cursor walk ------------------
	{
		const sqlIds = (
			await pool.query(
				`SELECT e.id FROM message_edits e JOIN messages m ON m.id = e.message_id
				 WHERE m.channel_id = 'ch2'
				 ORDER BY e.edited_at DESC, e.id DESC`,
			)
		).rows.map((r) => r.id);
		const r = await repo.getRecentEdits(50, "ch2");
		check(
			"getRecentEdits (channelId=ch2)",
			same(sqlIds, r.results.map((x) => x.id)),
			`${sqlIds.length} rows`,
		);
	}

	// --- getEditHistory ------------------------------------------------------
	await compareOrdered(
		"getEditHistory",
		`SELECT old_content, edited_at FROM message_edits
		 WHERE message_id = $1 ORDER BY edited_at DESC LIMIT 50`,
		async () => repo.getEditHistory("m0015"),
		["m0015"],
	);

	// --- getAnalysisAttempts -------------------------------------------------
	await compareOrdered(
		"getAnalysisAttempts",
		`SELECT attempt, outcome, created_at FROM analysis_attempts
		 WHERE message_id = $1 ORDER BY created_at ASC, id ASC`,
		async () => repo.getAnalysisAttempts("m0015"),
		["m0015"],
	);

	// --- listGuilds / listTextChannels ---------------------------------------
	{
		const guilds = (
			await pool.query(
				`SELECT DISTINCT guild_id FROM messages ORDER BY guild_id`,
			)
		).rows.map((r) => r.guild_id);
		const got = (await repo.listGuilds()).map((g) => g.id);
		check("listGuilds", same(guilds, got), `${got.length} guilds`);

		const chans = (
			await pool.query(
				`SELECT DISTINCT channel_id FROM messages WHERE guild_id = 'g1' ORDER BY channel_id`,
			)
		).rows.map((r) => r.channel_id);
		const gotChans = (await repo.listTextChannels("g1")).map((c) => c.id);
		check(
			"listTextChannels",
			same(chans, gotChans),
			`${gotChans.length} channels`,
		);
	}

	// --- streamMany must agree with findMany's paging ------------------------
	{
		const streamed = [];
		for await (const m of repo.streamMany({}, 7)) streamed.push(m.id);
		let cursor;
		const paged = [];
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const r = await repo.findMany({ limit: 7, cursor });
			paged.push(...r.data.map((m) => m.id));
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}
		check(
			"streamMany matches findMany paging",
			same(streamed, paged),
			`${streamed.length} rows`,
		);
	}
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