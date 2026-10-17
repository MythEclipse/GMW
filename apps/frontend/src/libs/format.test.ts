import { describe, expect, test } from "vitest"
import { messageBody, messageLabel } from "./format"

/**
 * Gateway placeholder cleanup.
 *
 * A media-only message is stored with a stand-in for its payload —
 * `getDisplayContent()` on the gateway writes `[Attachment: shot.png]` (and
 * `[Sticker: …]`, `[Image: …]`, `[GIF: …]`) because the dashboard cannot render
 * the media itself. The stand-in is not author text, so both formatters strip
 * it; a clean that leaves it behind prints the placeholder to the reader
 * instead of the picture, which is what the dashboard did.
 *
 * The regexes had been corrupted to `IAttachment` by an over-broad rename, so
 * the pattern matched nothing and the placeholder survived to the DOM. These
 * cases pin the EXACT tokens the gateway emits, because a pattern that is one
 * letter off is indistinguishable from no pattern at all.
 */
describe("gateway placeholder cleanup", () => {
	const PLACEHOLDERS = [
		"[Attachment: Screenshot_20261018-011932.jpg]",
		"[Sticker: programmerindonesia44]",
		"[Image: cat.png]",
		"[GIF: dance.gif]",
	]

	test.each(PLACEHOLDERS)("messageBody strips %s", (placeholder) => {
		expect(messageBody(placeholder)).toBe("")
	})

	test.each(PLACEHOLDERS)("messageLabel strips %s", (placeholder) => {
		expect(messageLabel(placeholder, 72)).toBe("")
	})

	test("a placeholder sitting beside real text leaves only the text", () => {
		expect(messageBody("[Attachment: shot.png] hello there")).toBe(
			"hello there",
		)
		expect(messageBody("hello there [Attachment: shot.png]")).toBe(
			"hello there",
		)
	})

	test("stripping is case-insensitive, as the gateway casing is not guaranteed", () => {
		expect(messageBody("[attachment: shot.png]")).toBe("")
		expect(messageBody("[ATTACHMENT: shot.png]")).toBe("")
	})

	test("author text that merely mentions an attachment is left alone", () => {
		// Only the bracketed `[Token: value]` form is a placeholder. Ordinary
		// prose must survive, or the cleanup silently eats real messages.
		expect(messageBody("I sent an attachment yesterday")).toBe(
			"I sent an attachment yesterday",
		)
		expect(messageBody("[not a placeholder]")).toBe("[not a placeholder]")
	})

	test("a mention is replaced, not dropped", () => {
		expect(messageBody("<@123456789012345678> hey")).toBe("@someone hey")
	})

	test("custom emoji folds to its shortcode", () => {
		expect(messageBody("<:adobe:1520373128566411417>")).toBe(":adobe:")
	})
})

/**
 * A cleaned-empty body is the media-only signal.
 *
 * `messageBody` returns `""` for a media-only post, and callers branch on that
 * to decide between rendering the media and rendering a fallback string. The
 * contracts that matter: it never returns a placeholder, and it never returns
 * whitespace that a truthiness check would treat as content.
 */
describe("messageBody empty-body contract", () => {
	test("returns an empty string, never a placeholder, for media-only posts", () => {
		const body = messageBody("[Attachment: a.png]")
		expect(body).toBe("")
		expect(body.length).toBe(0)
	})

	test("does not return whitespace for a placeholder surrounded by spaces", () => {
		expect(messageBody("  [Attachment: a.png]  ").trim()).toBe("")
	})

	test("null and undefined degrade to an empty string", () => {
		expect(messageBody(null)).toBe("")
		expect(messageBody(undefined)).toBe("")
	})
})
