import { describe, expect, test } from "vitest"
import { reactionRowId } from "../src/infrastructure/modules-gateway/reaction-tracking/reactionCapture.js"

/**
 * `message_reactions.id` is the PRIMARY KEY and every insert uses
 * `onConflictDoNothing()`, so the id derivation decides whether a removal can be
 * stored at all.
 *
 * The regression: add and remove derived the SAME id. A removal therefore
 * collided with the existing add row and was dropped silently — no `remove` row
 * was ever written, and every net-reaction figure (adds minus removes) counted
 * removals as zero.
 *
 * These assertions are about the ID, not the database: the property that matters
 * is that a removal's key differs from the corresponding add's, while a repeat
 * of the same event still de-duplicates.
 */
const fakeReaction = { message: { id: "m1" } } as unknown as Parameters<
	typeof reactionRowId
>[0]

describe("reactionRowId", () => {
	test("an add and a remove for the same reaction get different ids", () => {
		const add = reactionRowId(fakeReaction, "🔥", "u1", "add")
		const remove = reactionRowId(fakeReaction, "🔥", "u1", "remove")

		expect(add).not.toBe(remove)
	})

	test("repeating the same event yields the same id, so it de-duplicates", () => {
		expect(reactionRowId(fakeReaction, "🔥", "u1", "add")).toBe(
			reactionRowId(fakeReaction, "🔥", "u1", "add"),
		)
	})

	test("different users, emojis and messages never collide", () => {
		const base = reactionRowId(fakeReaction, "🔥", "u1", "add")
		expect(base).not.toBe(reactionRowId(fakeReaction, "🔥", "u2", "add"))
		expect(base).not.toBe(reactionRowId(fakeReaction, "👍", "u1", "add"))

		const otherMessage = { message: { id: "m2" } } as unknown as Parameters<
			typeof reactionRowId
		>[0]
		expect(base).not.toBe(reactionRowId(otherMessage, "🔥", "u1", "add"))
	})

	test("the reaction type is the final segment, so ids are legible", () => {
		expect(reactionRowId(fakeReaction, "🔥", "u1", "remove")).toBe(
			"m1-🔥-u1-remove",
		)
	})
})
