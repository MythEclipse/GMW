/**
 * The vision pass must send REAL image content parts, not image URLs inlined
 * in the text.
 *
 * ## Why this test exists
 *
 * The feature shipped inert twice. First the description was computed and
 * dropped on the floor (never interpolated into the prompt). Once that was
 * fixed, the prompt carried a line like:
 *
 *     Deskripsikan 1 gambar berikut. URL: https://cdn.discordapp.com/x.png
 *
 * and the model answered, verbatim:
 *
 *     "Tidak dapat memproses URL gambar. Silakan unggah gambarnya secara langsung."
 *
 * That sentence was then fed to the moderation model as the "media
 * description", which concluded the image was unremarkable. So every image
 * message was judged with no visual evidence at all.
 *
 * The fix is structural, and this asserts the structure: the URL must appear
 * in `LlmRequest.images`, never in `LlmRequest.user`.
 */

import type { Pool } from "pg"
import { describe, expect, it } from "vitest"
import type {
	LlmGateway,
	LlmRequest,
} from "../src/modules-gateway/ai-moderation/llmGateway.js"
import { isVisionCapable } from "../src/modules-gateway/ai-moderation/worker.js"

const IMAGE_URL = "https://cdn.discordapp.com/attachments/1/x.png"

/** A Pool stub that answers the single attachment query the vision pass runs. */
function poolWith(
	attachments: Array<{ type: string | null; url: string | null }>,
) {
	return {
		query: async (_sql: string, _params: unknown[]) => ({
			rows: attachments.map((a) => ({
				discord_url: a.url,
				type: a.type,
			})),
		}),
	} as unknown as Pool
}

/** Capture what the vision call was actually asked to do. */
function capturingGateway(): LlmGateway & { seen: LlmRequest | null } {
	const g = {
		seen: null as LlmRequest | null,
		modelLabel: "stub",
		async complete(req: LlmRequest) {
			g.seen = req
			return "Seseorang memotret layar permainan di ponsel"
		},
	}
	return g
}

/**
 * Ask the vision pass to describe a message's media, and return the request
 * the vision gateway received.
 *
 * This goes through the real `generateVisionDescription`, so it exercises the
 * attachment query, the capability filter, the model selection and the
 * request shape — everything except the network.
 */
async function visionRequestFor(
	attachments: Array<{ type: string | null; url: string | null }>,
): Promise<LlmRequest | null> {
	const { generateVisionDescriptionForTest } = await import(
		"../src/modules-gateway/ai-moderation/worker.js"
	)
	const vision = capturingGateway()
	await generateVisionDescriptionForTest(
		poolWith(attachments),
		{ id: "m-img", hasMedia: true } as never,
		vision,
	)
	return vision.seen
}

describe("vision pass sends real image parts", () => {
	it("puts the URL in `images`, not in the text prompt", async () => {
		const seen = await visionRequestFor([{ type: "image/png", url: IMAGE_URL }])

		expect(seen).not.toBeNull()
		// The whole point: a real multimodal part, not a URL in prose.
		expect(seen?.images).toEqual([{ url: IMAGE_URL }])
		// And the text must NOT contain the URL — that is the exact shape that
		// produced "Tidak dapat memproses URL gambar".
		expect(seen?.user ?? "").not.toContain("cdn.discordapp.com")
		expect(seen?.user ?? "").not.toContain(IMAGE_URL)
	})

	it("returns an empty description when the model refuses", async () => {
		// A refusal must not be written into the metadata as a "description" —
		// the moderation model would treat it as evidence the image is fine.
		const pool = poolWith([{ type: "image/png", url: IMAGE_URL }])
		const refusing: LlmGateway = {
			modelLabel: "stub",
			async complete() {
				return "   "
			},
		}
		const { generateVisionDescriptionForTest } = await import(
			"../src/modules-gateway/ai-moderation/worker.js"
		)
		const out = await generateVisionDescriptionForTest(
			pool,
			{ id: "m1", hasMedia: true } as never,
			refusing,
		)
		expect(out).toBe("")
	})
})

describe("isVisionCapable", () => {
	it("accepts real image types", () => {
		for (const t of [
			"image/png",
			"image/jpeg",
			"image/jpg",
			"image/gif",
			"image/webp",
		]) {
			expect(isVisionCapable(t)).toBe(true)
		}
	})

	it("tolerates a charset parameter and mixed case", () => {
		expect(isVisionCapable("IMAGE/PNG; charset=binary")).toBe(true)
	})

	it("rejects formats providers will not accept as an image part", () => {
		// A rejected media type fails the WHOLE request, taking the description
		// — and therefore the verdict — down with it.
		expect(isVisionCapable("image/svg+xml")).toBe(false)
		expect(isVisionCapable("image/avif")).toBe(false)
		expect(isVisionCapable("application/zip")).toBe(false)
		expect(isVisionCapable("video/mp4")).toBe(false)
		expect(isVisionCapable("text/plain")).toBe(false)
	})

	it("falls back to the extension when no content type was recorded", () => {
		expect(isVisionCapable(null, "https://x/a.PNG?ex=1")).toBe(true)
		expect(isVisionCapable(null, "https://x/a.jpeg")).toBe(true)
		expect(isVisionCapable(null, "https://x/a.mp4")).toBe(false)
		expect(isVisionCapable(null, "https://x/noextension")).toBe(false)
		expect(isVisionCapable(null, null)).toBe(false)
	})
})
