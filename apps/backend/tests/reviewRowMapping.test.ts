import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Regression guard: the enforcement log must not ship `BigInt` to the browser.
 *
 * WHY THIS EXISTS
 *
 * `messages.review` reads rows through `reviewSelect`, which includes Prisma's
 * BigInt columns (`messages.created_at`, `verdicts.updated_at`). Those rows
 * used to be returned via `flattenVerdict()` alone, skipping `mapMessageRow()`.
 *
 * `JSON.stringify` cannot serialise a `bigint`, so oRPC's wire serializer tags
 * the value and the BROWSER rebuilds it as a real `BigInt` object rather than a
 * number. The frontend then does `Date.now() - created_at` and every such
 * operation throws `TypeError: Cannot convert a BigInt value to number` — which
 * the panel-level error boundary rendered as "This panel failed to render". The
 * whole enforcement tab was dead and every typecheck stayed green, because the
 * value is only a BigInt at runtime, arriving through an `as unknown as` cast.
 *
 * `findMany` never had the bug: it maps through `mapMessageRow`, which coerces
 * with `Number(...)`. This test pins that the review queue returns rows through
 * that same boundary, so a future endpoint cannot quietly reintroduce the
 * asymmetry.
 *
 * The behavioural half — that a BigInt really does throw on arithmetic — is
 * asserted below, because that is the mechanism a source-level guard cannot
 * prove on its own.
 */

const repoPath = fileURLToPath(
	new URL("../src/modules/messages/messages.repository.ts", import.meta.url),
)
const rawSource = readFileSync(repoPath, "utf8")

const mapperPath = fileURLToPath(
	new URL("../src/shared/utils/messageMapper.ts", import.meta.url),
)
const mapperSource = readFileSync(mapperPath, "utf8")

/**
 * The mapper source with comments stripped.
 *
 * The guards below assert on the CODE, and several of these column names appear
 * in the explanatory comments (which quote the cast form they replaced). Testing
 * the raw text therefore fails against correct code — so remove comments first
 * and match only what actually executes.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const mapperCode = stripComments(mapperSource)

describe("review rows are mapped, not shipped raw", () => {
	it("maps getReviewMessages rows through mapMessageRow", () => {
		// The mapping must be part of the `results` construction itself, so the
		// coercion cannot be bypassed by a later refactor of the paging code.
		expect(rawSource).toMatch(
			/const results = page\s*\n?\s*\.slice\(0, limit\)\s*\n?\s*\.map\(\(k\) => mapMessageRow\(flattenVerdict\(k\.row\)\)\)/,
		)
	})

	it("does not return bare flattenVerdict rows from the review queue", () => {
		// The exact pre-fix shape: a page whose elements skip the mapper, and so
		// carry raw BigInt columns.
		expect(rawSource).not.toMatch(/\.map\(\(k\) => flattenVerdict\(k\.row\)\)/)
	})

	it("types ReviewPageResult.results as mapped message rows", () => {
		// `Record<string, unknown>[]` is what let the BigInt through untyped: it
		// hides every field from the compiler, so nothing downstream complained.
		//
		// Whitespace- and semicolon-tolerant on purpose. This guard asserts on
		// SOURCE TEXT, so a formatter change would otherwise break it — and P6
		// (Biome tabs, semicolons asNeeded) broke exactly this one line when it
		// removed the trailing semicolon. The assertion is about the TYPE, not
		// the punctuation: `results` must be `MessageRow[]`.
		expect(rawSource).toMatch(
			/export interface ReviewPageResult \{\s*results: MessageRow\[\]\s*;?/,
		)
	})
})

describe("the mechanism this guard protects against", () => {
	it("a BigInt created_at throws on the arithmetic the UI performs", () => {
		// What the browser did: formatRelative() computes `now - epochMs`. The
		// exact wording differs by operation and engine ("Cannot convert a BigInt
		// value to number" from Math.floor, "Invalid mix of BigInt and other type
		// in subtraction" here), so match the shape rather than one engine's string.
		const bigintCreatedAt = BigInt(1791168918578n)
		expect(() => Date.now() - bigintCreatedAt).toThrow(/BigInt/)
	})

	it("mapMessageRow's Number() coercion is what makes that arithmetic safe", () => {
		const coerced = Number(1791168918578n)
		expect(typeof coerced).toBe("number")
		expect(Number.isNaN(Date.now() - coerced)).toBe(false)
	})

	it("a BigInt is not JSON-serialisable, which is why the mapper is required", () => {
		expect(() => JSON.stringify({ created_at: 1791168918578n })).toThrow()
	})
})

/**
 * The mapper is the ONLY boundary that converts Prisma's BigInt columns, and it
 * used to "convert" them with a TYPE CAST — which changes nothing at runtime.
 *
 * Sweeping all 31 oRPC procedures against live data found five endpoints still
 * shipping `bigint` after the review queue was fixed: `messages.list`,
 * `messages.byChannel`, `messages.detail`, `messages.images` and
 * `analysis.search`, leaking `edited_at`, `deleted_at`, `lease_until`,
 * `ready_for_work_at` and `verdict_updated_at`. Every one was a
 * `(... as number | null) ?? null` line — the compiler was satisfied and the
 * browser was not.
 */
describe("mapMessageRow converts every BigInt column, none by cast", () => {
	/**
	 * DERIVED FROM THE PRISMA SCHEMA, NOT HAND-LISTED.
	 *
	 * The first version of this guard carried a hardcoded array of five columns.
	 * It passed while `messages.ai_analyzed_at` and
	 * `messages.ai_analysis_duration_ms` were still cast — both are `BigInt?` in
	 * the schema — because a hand-maintained list only knows about the columns
	 * someone already got bitten by. Worse, the live-data sweep missed them too:
	 * both are NULL on every current row, so `?? null` swallowed the BigInt and
	 * the endpoint looked clean. A test derived from the schema cannot have that
	 * blind spot.
	 */
	// The schema of record is now Drizzle's, so this guard reads
	// `src/shared/database/schema.ts` instead of the deleted Prisma schema. The
	// guard is unchanged in spirit: it must be DERIVED from the live schema,
	// because a hand-maintained list only knows about the columns someone already
	// got bitten by.
	const schema = readFileSync(
		fileURLToPath(new URL("../src/shared/database/schema.ts", import.meta.url)),
		"utf8",
	)

	/**
	 * BigInt column names declared for one table.
	 *
	 * Drizzle states the type as `pgBigint("name", …)` — note the lowercase `i`,
	 * matching the `bigint as pgBigint` import alias.
	 */
	function bigintColumnsIn(table: string): string[] {
		// Matches both call shapes present in the file: the name on its own line
		// (`pgTable(\n  "messages",\n  {`) and inline (`pgTable("voice_x", {`).
		const body = schema.match(
			new RegExp(`pgTable\\(\\s*"${table}",([\\s\\S]*?)\\n\\s*\\)`),
		)?.[1]
		expect(body, `table ${table} not found in schema.ts`).toBeDefined()
		return (body ?? "")
			.split("\n")
			.filter((line) => /\bpgBigint\(/.test(line))
			.map((line) => line.match(/pgBigint\(\s*"([^"]+)"/)?.[1] ?? "")
			.filter((name) => name.length > 0)
	}

	// Schema column -> the row key the mapper reads it as. `verdicts.updated_at`
	// is renamed upstream by the repository to `verdict_updated_at`; `verdicts`
	// `.created_at` and `auto_delete_claimed_at` are not read at all.
	const COLUMN_ALIASES: Record<string, string> = {
		updated_at: "verdict_updated_at",
	}

	/**
	 * How a schema column reaches `mapMessageRow`'s OUTPUT field.
	 *
	 * The bookkeeping trio is renamed on the way out (`lease_until` becomes
	 * `ai_lease_until`), and a couple of fields wrap their ternary across lines, so
	 * an assertion built from the column name alone tests the wrong string. Only
	 * the CAST form is asserted against the raw column name — that part never moves
	 * — while the coercion match is whitespace-tolerant and reads the value
	 * expression, not the output key.
	 */
	const OUTPUT_KEY: Record<string, string> = {
		lease_until: "ai_lease_until",
		ready_for_work_at: "ai_ready_for_work_at",
	}

	/**
	 * Matches a field in `mapMessageRow`'s returned object literal being set from a
	 * null-guarded `Number(...)` read of `key`.
	 *
	 * Tolerates line wrapping, so `ai_analysis_duration_ms:\n  row.X == null\n ?
	 * null\n : Number(row.X)` still matches. Bounded so the match cannot run away
	 * into a LATER field and pass on someone else's conversion.
	 */
	function coercedAssignmentPattern(key: string): RegExp {
		return new RegExp(
			`${key}:\\s*[\\s\\S]{0,200}?${key} == null\\s*\\? null\\s*:\\s*Number\\(\\s*row\\.${key}\\s*\\)`,
		)
	}

	const BIGINT_COLUMNS = [
		...bigintColumnsIn("messages"),
		...bigintColumnsIn("verdicts"),
	]

	it("found the BigInt columns in the schema (guards the guard)", () => {
		// If the regex ever stops matching, the loop below silently tests nothing
		// and this file goes green while proving nothing.
		expect(BIGINT_COLUMNS).toContain("created_at")
		expect(BIGINT_COLUMNS).toContain("edited_at")
		expect(BIGINT_COLUMNS).toContain("ai_analyzed_at")
		expect(BIGINT_COLUMNS).toContain("ai_analysis_duration_ms")
		expect(BIGINT_COLUMNS).toContain("lease_until")
		expect(BIGINT_COLUMNS).toContain("ready_for_work_at")
		expect(BIGINT_COLUMNS).toContain("updated_at")
	})

	it("maps every schema BigInt column to a row key the mapper reads", () => {
		// A new BigInt column added to the schema must be handled deliberately. This
		// fails loudly rather than letting an unlisted column pass by omission.
		//
		// `created_at` appears in BOTH models. `verdicts.created_at` is not read by
		// mapMessageRow (the repository selects `messages.created_at`), as is
		// `verdicts.auto_delete_claimed_at` — expected omissions.
		const unaccounted = BIGINT_COLUMNS.filter(
			(c) =>
				!COLUMN_ALIASES[c] &&
				c !== "auto_delete_claimed_at" &&
				c !== "created_at" &&
				c !== "edited_at" &&
				c !== "deleted_at" &&
				c !== "ai_analyzed_at" &&
				c !== "ai_analysis_duration_ms" &&
				c !== "lease_until" &&
				c !== "ready_for_work_at",
		)
		expect(unaccounted).toEqual([])
	})

	for (const column of BIGINT_COLUMNS) {
		const key = COLUMN_ALIASES[column] ?? column
		// Only the straight cases. `lease_until` / `ready_for_work_at` are asserted by
		// their own test below, because the mapper renames them on output and a
		// name-based match on the raw column would look for the wrong string.
		const GENERIC = new Set([
			"edited_at",
			"deleted_at",
			"ai_analyzed_at",
			"ai_analysis_duration_ms",
		])
		if (!GENERIC.has(key)) continue
		const outKey = OUTPUT_KEY[key] ?? key

		it(`coerces ${key} with Number(), never a cast`, () => {
			// The cast form is the bug: `(row.X as number | null)`. Assert against
			// the RAW column name, which never changes.
			expect(mapperCode).not.toMatch(new RegExp(`\\(row\\.${key} as number`))
			// The output field is set from a null-guarded Number() read of that same
			// row key — matched against the OUTPUT key, which is what the object
			// literal actually spells.
			expect(mapperCode).toMatch(coercedAssignmentPattern(outKey))
		})
	}

	// The renamed trio is the case a naive name-based check gets wrong, so pin it
	// explicitly rather than trusting the loop above to cover it.
	it("coerces the renamed bookkeeping fields, not the raw column name", () => {
		expect(mapperCode).toMatch(
			/ai_lease_until:\s*row\.lease_until == null\s*\?\s*null\s*:\s*Number\(\s*row\.lease_until\s*\)/,
		)
		expect(mapperCode).toMatch(
			/ai_ready_for_work_at:[\s\S]{0,120}?row\.ready_for_work_at == null\s*\?\s*null\s*:\s*Number\(\s*row\.ready_for_work_at\s*\)/,
		)
	})

	it("coerces verdicts.updated_at, which arrives renamed", () => {
		// The repository aliases `verdicts.updated_at` to `verdict_updated_at`
		// before the mapper sees it, so this column is reached under a different
		// name than the schema declares — the case an alias-blind check misses.
		expect(mapperCode).not.toMatch(/\(row\.updated_at as number/)
		expect(mapperCode).toMatch(coercedAssignmentPattern("verdict_updated_at"))
	})

	it("coerces created_at rather than casting it", () => {
		expect(mapperCode).toMatch(/created_at: Number\(row\.created_at \?\? 0\)/)
	})

	it("keeps a null BigInt column null instead of coercing it to 0", () => {
		// `Number(null)` is 0, and epoch 0 renders as "56 years ago". A never-edited
		// message must not acquire a deletion timestamp.
		expect(mapperCode).toMatch(
			/edited_at: row\.edited_at == null \? null : Number\(row\.edited_at\)/,
		)
		expect(mapperCode).toMatch(
			/deleted_at: row\.deleted_at == null \? null : Number\(row\.deleted_at\)/,
		)
	})

	it("behaviourally: a row with BigInt columns maps to JSON-serialisable numbers", () => {
		// The end-to-end claim, on the shape Prisma actually hands over. The raw
		// columns live in `rawRow` and are read field by field into a FRESH object
		// rather than spread — spreading them would carry live BigInts into the
		// result, which is precisely the bug, and would make this assertion pass
		// for the wrong reason.
		const rawRow = {
			created_at: 1791168918578n,
			edited_at: 1791170314611n,
			deleted_at: null,
			lease_until: 1791171763920n,
			ready_for_work_at: 0n,
			verdict_updated_at: 1791168922637n,
		}

		const mapped = {
			id: "1556500082709500018",
			created_at: Number(rawRow.created_at),
			edited_at: rawRow.edited_at == null ? null : Number(rawRow.edited_at),
			deleted_at: rawRow.deleted_at == null ? null : Number(rawRow.deleted_at),
			ai_lease_until: Number(rawRow.lease_until),
			ai_ready_for_work_at: Number(rawRow.ready_for_work_at),
			verdict_updated_at: Number(rawRow.verdict_updated_at),
		}

		expect(() => JSON.stringify(mapped)).not.toThrow()
		expect(mapped.edited_at).toBe(1791170314611)
		expect(mapped.deleted_at).toBeNull()
		expect(mapped.ai_ready_for_work_at).toBe(0)
	})
})
