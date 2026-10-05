import { randomBytes } from "node:crypto"
import pg from "pg"

/**
 * Per-file Postgres schema isolation.
 *
 * WHY THIS EXISTS: eleven files in this directory TRUNCATE the same tables in
 * `beforeAll`/`beforeEach`. Under bun they ran sequentially, so they were safe by
 * accident of the runner. Vitest parallelises by default, and the files then
 * wipe each other's rows mid-run — `worker.test.ts` passes 31/31 alone and fails
 * in the full suite for exactly that reason. The fix chosen at the time was
 * `fileParallelism: false` in vitest.config.ts, which serialises the whole suite
 * and hides the coupling rather than removing it.
 *
 * WHAT IT DOES: every file gets its own schema, named from the file plus a
 * random suffix, with `search_path` pinned to it on the pool. A `TRUNCATE
 * messages` inside that file can only see that file's tables. Two files may then
 * run concurrently without observing each other.
 *
 * WHY A SCHEMA AND NOT A TRANSACTION: the tests need real commits and a real
 * worker loop across many round trips; a rolled-back transaction would hide all
 * of it. Schemas are also cheap — CREATE SCHEMA is a catalogue entry, no table
 * copying.
 *
 * WHY `CREATE TABLE ... LIKE public.<t>`: the production schema, including its
 * CHECK constraints and its functions, lives in `public`. Each file gets
 * structurally identical tables without duplicating the DDL, so a schema change
 * in migrations/ does not silently desynchronise the tests.
 *
 * NOT USED BY ANY FILE YET: this helper is the mechanism. Adopting it across the
 * eleven files is a separate, per-file change, verified one file at a time. Each
 * adoption is behaviour-preserving — the schema name and the unqualified table
 * names in the SQL stay exactly as they are.
 */

const DB_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:postgres@127.0.0.1:5433/gmw_mod"

/** Tables the gateway tests truncate or seed. Mirrors their TRUNCATE lists. */
const MIRRORED_TABLES = [
	"messages",
	"verdicts",
	"analysis_attempts",
	"attachments",
	"message_reviews",
	"message_edits",
	"moderation_actions",
	"reactions",
	"user_profiles",
	"chatbot_messages",
] as const

export interface IsolatedPool {
	pool: pg.Pool
	/** Safe to call more than once; each call after the first is a no-op. */
	cleanup: () => Promise<void>
}

/**
 * Create a pool pinned to a fresh schema containing copies of the production
 * tables.
 *
 * Throws when the database is unreachable or when the `search_path` pin fails to
 * take — a pool that silently fell back to `public` would reintroduce exactly
 * the cross-file truncation this exists to prevent. Use
 * `tryCreateIsolatedPool` for files that have always degraded to a no-op.
 */
export async function createIsolatedPool(
	fileLabel: string,
	options: { max?: number } = {},
): Promise<IsolatedPool> {
	const schema = `t_${fileLabel}_${randomBytes(4).toString("hex")}`
	const admin = new pg.Pool({ connectionString: DB_URL, max: 1 })
	let pool: pg.Pool | undefined
	let dropped = false

	try {
		await admin.query(`CREATE SCHEMA "${schema}"`)

		// Structure only, no rows. IF NOT EXISTS so a retry after a partial failure
		// does not hard-error on the tables that did land.
		for (const table of MIRRORED_TABLES) {
			await admin.query(
				`CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
			)
		}

		pool = new pg.Pool({
			connectionString: DB_URL,
			max: options.max ?? 4,
			// Pin search_path ON THE POOL, so every connection it hands out resolves
			// unqualified names into the schema. That is what makes it survive pool
			// growth; a per-connection SET would apply to one session only.
			options: `-c search_path=${schema},public`,
		})

		// Verify the pin took rather than trusting it.
		const { rows } = await pool.query<{ sp: string }>("SHOW search_path")
		if (!rows[0]?.sp?.includes(schema)) {
			throw new Error(
				`search_path not pinned to ${schema} (got: ${rows[0]?.sp})`,
			)
		}

		return {
			pool,
			cleanup: async () => {
				await pool?.end()
				if (dropped) return
				dropped = true
				await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
				await admin.end()
			},
		}
	} catch (error) {
		await pool?.end().catch(() => undefined)
		await admin
			.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
			.catch(() => undefined)
		await admin.end().catch(() => undefined)
		throw error
	}
}

/**
 * The variant for files that have always degraded to a no-op when the database
 * is unreachable. Returns null instead of throwing.
 */
export async function tryCreateIsolatedPool(
	fileLabel: string,
	options: { max?: number } = {},
): Promise<IsolatedPool | null> {
	try {
		return await createIsolatedPool(fileLabel, options)
	} catch {
		return null
	}
}

/** The URL these tests connect to, for diagnostics. */
export const integrationDatabaseUrl = DB_URL
