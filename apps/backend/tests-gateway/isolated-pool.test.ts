import pg from "pg"
import { afterEach, expect, test } from "vitest"
import {
	createIsolatedPool,
	integrationDatabaseUrl,
	tryCreateIsolatedPool,
} from "./isolated-pool.js"

/**
 * The isolation helper tested against a real Postgres.
 *
 * The first three skip (rather than fail) when the schema is unavailable,
 * matching the convention the other gateway tests use — a developer without
 * Postgres should not see a red suite for an infrastructure reason. But a skip
 * that reads as a pass is exactly the failure mode this helper has to avoid, so
 * a skipped one says so out loud instead of returning a bare `true`.
 *
 * The load-bearing assertions are the second and third: a pool whose
 * `search_path` did NOT get pinned would silently truncate the shared `public`
 * tables and reintroduce the exact cross-file corruption this helper exists to
 * prevent.
 */

/** Unreachable schema → a visible skip, never a silent one. */
function skipIfNoSchema(iso: { pool: pg.Pool } | null): iso is null {
	if (iso) return false
	console.warn(
		"[isolated-pool.test] SKIPPED — no test schema available; these assertions did NOT run",
	)
	return true
}

// The strict-mode test sets this; restore it so it cannot leak into other files.
const originalRequire = process.env.GMW_REQUIRE_TEST_DB
afterEach(() => {
	if (originalRequire === undefined) delete process.env.GMW_REQUIRE_TEST_DB
	else process.env.GMW_REQUIRE_TEST_DB = originalRequire
})

test("two isolated pools cannot see each other's rows", async () => {
	const a = await tryCreateIsolatedPool("iso_a")
	const b = await tryCreateIsolatedPool("iso_b")
	if (skipIfNoSchema(a) || skipIfNoSchema(b)) return

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
	if (skipIfNoSchema(iso)) return

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
	if (skipIfNoSchema(iso)) return

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

test("strict mode turns a skipped file into a failure", async () => {
	// The regression this guards: CI provisions an empty postgres, so every
	// DB-backed file skips. Permissively that is a GREEN suite testing nothing.
	// With GMW_REQUIRE_TEST_DB=1 it must throw instead.
	process.env.GMW_REQUIRE_TEST_DB = "1"

	const probe = new pg.Pool({
		connectionString: integrationDatabaseUrl,
		max: 1,
	})
	const missing = await probe
		.query<{ n: string }>(
			"SELECT count(*)::text n FROM information_schema.tables WHERE table_schema='public' AND table_name='messages'",
		)
		.then((r) => r.rows[0].n === "0")
		.finally(() => probe.end())

	if (!missing) {
		// The real schema is present, so there is nothing to simulate.
		await expect(createIsolatedPool("iso_strict")).resolves.toBeTruthy()
		return
	}

	// createIsolatedPool surfaces the raw cause; the strict-mode framing is
	// tryCreateIsolatedPool's job, because that is the one callers use.
	await expect(createIsolatedPool("iso_strict")).rejects.toThrow(
		/public\.messages.*does not exist/s,
	)
	await expect(tryCreateIsolatedPool("iso_strict")).rejects.toThrow(
		/GMW_REQUIRE_TEST_DB=1 is set/,
	)
})
