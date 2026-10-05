import pg from "pg"
import { expect, test } from "vitest"
import {
	integrationDatabaseUrl,
	tryCreateIsolatedPool,
} from "./isolated-pool.js"

/**
 * The isolation helper tested against a real Postgres.
 *
 * Skips (rather than fails) when no database is reachable, matching the
 * convention the other gateway tests already use — a developer without Postgres
 * should not see a red suite for an infrastructure reason.
 *
 * The load-bearing assertion is the second one: a pool whose `search_path` did
 * NOT get pinned would silently truncate the shared `public` tables and
 * reintroduce the exact cross-file corruption this helper exists to prevent.
 */

test("two isolated pools cannot see each other's rows", async () => {
	const a = await tryCreateIsolatedPool("iso_a")
	const b = await tryCreateIsolatedPool("iso_b")
	if (!a || !b) return expect(true).toBe(true)

	try {
		await a.pool.query(
			`INSERT INTO messages (id, guild_id, channel_id, user_id, username, content, created_at, ai_status, ready_for_work_at)
			 VALUES ('iso-a-1','g1','c1','u1','user1','from a',1,'pending',0)`,
		)

		// The whole point: B must not see A's row.
		const { rows } = await b.pool.query<{ n: string }>(
			"SELECT count(*)::text n FROM messages WHERE id LIKE 'iso-%'",
		)
		expect(rows[0].n).toBe("0")

		// And B's own writes land in B's schema.
		await b.pool.query(
			`INSERT INTO messages (id, guild_id, channel_id, user_id, username, content, created_at, ai_status, ready_for_work_at)
			 VALUES ('iso-b-1','g1','c1','u1','user1','from b',1,'pending',0)`,
		)
		const seen = await b.pool.query<{ n: string }>(
			"SELECT count(*)::text n FROM messages WHERE id LIKE 'iso-%'",
		)
		expect(seen.rows[0].n).toBe("1")
	} finally {
		await a.cleanup()
		await b.cleanup()
	}
})

test("a TRUNCATE in an isolated pool leaves public untouched", async () => {
	const iso = await tryCreateIsolatedPool("iso_trunc")
	if (!iso) return expect(true).toBe(true)

	try {
		// A sentinel in public, written with an EXPLICIT schema qualification so it
		// cannot land in the isolated schema by accident.
		await iso.pool.query(
			"CREATE TABLE IF NOT EXISTS public.iso_sentinel (id text primary key)",
		)
		await iso.pool.query(
			"INSERT INTO public.iso_sentinel (id) VALUES ('keep-me') ON CONFLICT (id) DO NOTHING",
		)

		await iso.pool.query("TRUNCATE messages")

		const { rows } = await iso.pool.query<{ n: string }>(
			"SELECT count(*)::text n FROM public.iso_sentinel",
		)
		expect(rows[0].n).toBe("1")

		await iso.pool.query("DROP TABLE public.iso_sentinel")
	} finally {
		await iso.cleanup()
	}
})

test("cleanup drops the schema it created", async () => {
	const iso = await tryCreateIsolatedPool("iso_cleanup")
	if (!iso) return expect(true).toBe(true)

	const before = await iso.pool.query<{ n: string }>(
		"SELECT count(*)::text n FROM information_schema.schemata WHERE schema_name LIKE 't_iso_cleanup%'",
	)
	expect(before.rows[0].n).toBe("1")

	await iso.cleanup()

	// A fresh connection is required: the dropped schema is invisible to new
	// sessions, while the old session still has it in its search_path.
	const probe = new pg.Pool({
		connectionString: integrationDatabaseUrl,
		max: 1,
	})
	try {
		const after = await probe.query<{ n: string }>(
			"SELECT count(*)::text n FROM information_schema.schemata WHERE schema_name LIKE 't_iso_cleanup%'",
		)
		expect(after.rows[0].n).toBe("0")
	} finally {
		await probe.end()
	}
})
