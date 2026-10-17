import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * The responsive tab strip.
 *
 * `TabsList` is 32px from the primitive, which leaves 25px triggers — fine for
 * a mouse, under the 44px touch minimum for a finger. `.tabs-touch` raises the
 * list and its triggers to 44px, and that override must apply ONLY below `sm`.
 *
 * The bug this guards: the rule used to apply unconditionally and then "undo"
 * itself at `>= 40rem` with `height: 0`. `height: 0` is a real used height, not
 * a return to `auto`, so the primitive's own `h-[calc(100%-1px)]` never took
 * over; with `border-box` the trigger collapsed to its padding plus border and
 * rendered 6px tall, with a 20px line box overflowing it. Measured live at
 * 1440px: triggers were 6px. The regression is invisible to every other gate —
 * it compiles, lints, types and tests green, and only shows up as a visual
 * sliver — so the rule shape itself is what has to be asserted.
 *
 * The assertions are on the SHAPE of the rule (scoped by a max-width query, no
 * zeroing reset), not on an exact stylesheet, so unrelated edits stay free.
 */
const STYLES = readFileSync(
	path.resolve(import.meta.dirname, "styles.css"),
	"utf8",
)

describe(".tabs-touch is scoped to touch widths", () => {
	/** Every `@media` block whose body mentions `.tabs-touch`, with its condition. */
	function mediaBlocks(): Array<{ condition: string; body: string }> {
		const blocks: Array<{ condition: string; body: string }> = []
		const re = /@media\s*\(([^)]*)\)\s*\{/g
		for (const match of STYLES.matchAll(re)) {
			const condition = match[1]
			// Walk braces from this block's `{` to find its end.
			let depth = 1
			let i = match.index + match[0].length
			const start = i
			while (i < STYLES.length && depth > 0) {
				if (STYLES[i] === "{") depth++
				else if (STYLES[i] === "}") depth--
				i++
			}
			const body = STYLES.slice(start, i - 1)
			if (body.includes(".tabs-touch")) blocks.push({ condition, body })
		}
		return blocks
	}

	test("every .tabs-touch rule sits inside a max-width media query", () => {
		const blocks = mediaBlocks()
		expect(
			blocks.length,
			".tabs-touch has no max-width-scoped media block — it is either missing " +
				"or applying at every width, which collapses the strip on desktop.",
		).toBeGreaterThan(0)

		for (const { condition } of blocks) {
			expect(
				condition,
				`a .tabs-touch block is scoped to "(${condition})"; it must be a ` +
					`max-width query (e.g. "width < 40rem") so desktop keeps the ` +
					`primitive's own sizing.`,
			).toMatch(/width\s*<\s*[\d.]+(rem|px)/)
		}
	})

	test("the touch override is 44px (2.75rem) on both list and trigger", () => {
		const joined = mediaBlocks()
			.map((b) => b.body)
			.join("\n")
		expect(joined).toMatch(/\.tabs-touch\s*\{[^}]*min-height:\s*2\.75rem/)
		expect(joined).toMatch(
			/\.tabs-touch\s*>\s*\[data-slot="tabs-trigger"\]\s*\{[^}]*min-height:\s*2\.75rem/,
		)
	})

	test("no reset sets height/min-height to 0", () => {
		// The specific regression: "undo" written as a zero. Any zeroing of
		// height inside a tabs rule re-creates the 6px collapse.
		const joined = mediaBlocks()
			.map((b) => b.body)
			.join("\n")
		expect(
			joined,
			"a .tabs-touch rule zeroes height/min-height. That does not restore the " +
				"primitive's height (auto would); it collapses the control.",
		).not.toMatch(/(?:^|[\s;{])(?:min-)?height:\s*0(?:px|rem|%)?\s*[;}]/)
	})
})
