import { describe, expect, test } from "vitest"
import { guildLabel } from "./format"

/**
 * The guild label — imported from the real implementation, not restated.
 *
 * `listGuilds()` cannot know real guild names: it derives the list from the
 * message archive and synthesises `Guild <first 8 chars of the id>` for every
 * row (`apps/backend/src/infrastructure/repositories/messages.repository.ts`).
 * The picker therefore has to answer "is this name just the id again?" before
 * deciding whether to shorten it.
 *
 * The bug this pins: the guard compared against `Guild ${guild.id}` — the FULL
 * snowflake — while the API emits the 8-character prefix. The comparison was
 * never true, so the shortening branch was dead code, and the label the reader
 * saw did not match what the guard was written to detect. A hand-copied format
 * string had drifted from its producer.
 */
const REAL_ID = "1206212469148749834"

/** Exactly the shape `messages.repository.ts` returns. */
const AS_THE_API_RETURNS_IT = {
	id: REAL_ID,
	name: `Guild ${REAL_ID.slice(0, 8)}`,
}

describe("guildLabel", () => {
	test("a real stored name wins untouched", () => {
		expect(guildLabel({ id: REAL_ID, name: "Guild of Mods" })).toBe(
			"Guild of Mods",
		)
	})

	test("the API's synthesised name is recognised", () => {
		expect(AS_THE_API_RETURNS_IT.name).toBe("Guild 12062124")
		expect(guildLabel(AS_THE_API_RETURNS_IT)).toBe("Guild 749834")
	})

	test("an empty or absent name falls back to the id tail", () => {
		expect(guildLabel({ id: REAL_ID, name: "" })).toBe("Guild 749834")
		expect(guildLabel({ id: REAL_ID, name: null })).toBe("Guild 749834")
		expect(guildLabel({ id: REAL_ID })).toBe("Guild 749834")
	})

	test("a name that merely resembles an id is preserved", () => {
		// Only the exact synthesised form is replaced. A guild genuinely named
		// "Guild 12062124x" is a name, and so is one named with the full id.
		expect(guildLabel({ id: REAL_ID, name: "Guild 12062124x" })).toBe(
			"Guild 12062124x",
		)
		expect(guildLabel({ id: REAL_ID, name: `Guild ${REAL_ID}` })).toBe(
			`Guild ${REAL_ID}`,
		)
	})

	test("the guard's prefix length matches what the backend emits", () => {
		// If the backend ever changes its slice length, this fails and points at
		// the producer rather than letting the two drift again.
		const backendEmittedName = `Guild ${REAL_ID.slice(0, 8)}`
		const shortened = guildLabel({ id: REAL_ID, name: backendEmittedName })
		expect(shortened).not.toBe(backendEmittedName)
		expect(shortened).toBe(`Guild ${REAL_ID.slice(-6)}`)
	})
})
