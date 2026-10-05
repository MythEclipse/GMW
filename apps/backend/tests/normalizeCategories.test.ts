import { describe, expect, test } from "vitest"
import { normalizeCategories } from "../src/modules/moderation/moderation.repository.js"

/**
 * The SQL expression this replaces was verified against every distinct live
 * value plus adversarial junk. These cases are that verification, kept as
 * executable assertions so the two storage shapes cannot drift apart again.
 */
describe("normalizeCategories", () => {
	test("reads the current JSON-array shape", () => {
		expect(normalizeCategories('["gambling","scam"]')).toEqual([
			"gambling",
			"scam",
		])
	})

	test("reads the legacy CSV shape", () => {
		expect(normalizeCategories("inappropriate_content, spam")).toEqual([
			"inappropriate_content",
			"spam",
		])
	})

	test("reads a legacy bare category", () => {
		expect(normalizeCategories("harassment")).toEqual(["harassment"])
	})

	test("tolerates whitespace around CSV separators", () => {
		expect(normalizeCategories("a, b ,  c")).toEqual(["a", "b", "c"])
	})

	test("deduplicates", () => {
		expect(normalizeCategories('["spam","spam"]')).toEqual(["spam"])
		expect(normalizeCategories("spam,spam")).toEqual(["spam"])
	})

	test("adversarial input yields categories rather than throwing", () => {
		expect(normalizeCategories('{"not":"an array"}')).toEqual([
			"not",
			"an array",
		])
		expect(normalizeCategories("[unclosed")).toEqual(["[unclosed"])
		expect(normalizeCategories("a, b, , c")).toEqual(["a", "b", "c"])
	})

	test("empty and nullish input yield no categories", () => {
		expect(normalizeCategories("")).toEqual([])
		expect(normalizeCategories("   ")).toEqual([])
		expect(normalizeCategories(null)).toEqual([])
		expect(normalizeCategories(undefined)).toEqual([])
	})

	test("an empty JSON array falls through to comma splitting", () => {
		// `[]` contains no quoted tokens, so both this and the SQL expression take
		// the comma-split branch and yield the literal text. Verified against
		// Postgres: the expression returns {[]} for input '[]'.
		expect(normalizeCategories("[]")).toEqual(["[]"])
	})
})
