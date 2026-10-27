/**
 * A GIF link's only picture is `embed.thumbnail`, and the policy has to say
 * what a preview's own title means.
 *
 * ## The production bug
 *
 * Someone posted `https://klipy.com/gifs/hot-guy-18` in #general. Discord
 * resolved it to a `gifv` embed: title "Hot Guys Kissing", a `thumbnail` still
 * and an mp4 in `video`, with `image: null`. Three things then went wrong at
 * once, and all three are pinned here:
 *
 *   1. `renderEmbedBody` rendered `image` and `video` and skipped `thumbnail`
 *      and `type`, so the preview reached the model as a title and an
 *      unwatchable mp4 URL — no picture at all.
 *   2. Nothing in the prompt said what a `gifv` preview IS, so the model read
 *      the title as the whole content and treated "Hot Guys Kissing" as a
 *      joke: `clean`, score 0.05. A human moderator deleted it.
 *   3. The analysis it wrote — "dibagikan dalam obrolan umum sebagai bagian
 *      dari candaan santai antar anggota" — asserted a motive the sender
 *      never wrote.
 *
 * Replaying the real row through the real prompt builder: the pre-fix prompt
 * reproduced `clean/0.05`; with the animation rules in `LINK_RULES` the same
 * row came back `deleted`, `nsfw`, score 0.8. The thumbnail and type tags are
 * evidence completeness — they did NOT change that verdict on their own.
 */
import { describe, expect, it } from "vitest"
import {
	buildSystemPrompt,
	clearPromptCache,
	LINK_RULES,
} from "../src/infrastructure/modules-gateway/ai-moderation/policy.js"
import { formatLinkEvidenceForPrompt } from "../src/infrastructure/modules-gateway/message-capture/messageMetadata.js"

const KLIPY_URL = "https://klipy.com/gifs/hot-guy-18"

/** The captured `messages.metadata` for that message, verbatim from prod. */
const metadataWithGifvEmbed = JSON.stringify({
	stickers: [],
	embeds: [
		{
			title: "Hot Guys Kissing",
			description: null,
			url: KLIPY_URL,
			color: null,
			image: null,
			thumbnail:
				"https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/65/81/tszFK85ruwQkCHZZf2m.webp",
			author: null,
			footer: null,
			fields: [],
			type: "gifv",
			timestamp: null,
			video: {
				url: "https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/65/81/jlzRoJeRQCuXm.mp4",
				width: 390,
				height: 640,
			},
			provider: { name: "Klipy", url: "https://klipy.com" },
		},
	],
	attachments: [],
	customEmojis: [],
})

describe("a gifv preview carries its picture in thumbnail, not image", () => {
	const block = formatLinkEvidenceForPrompt(KLIPY_URL, metadataWithGifvEmbed)

	it("renders the thumbnail still", () => {
		expect(block).toContain("<thumbnail>https://static.klipy.com/")
	})

	it("renders the embed type, so the prompt says this is an animation", () => {
		expect(block).toContain("<type>gifv</type>")
	})

	it("still renders the title and the video url", () => {
		expect(block).toContain("<title>Hot Guys Kissing</title>")
		expect(block).toContain("<video>https://static.klipy.com/")
	})
})

describe("the animation rules ship in every prompt that has a link", () => {
	it("LINK_RULES says a suggestive preview title is nsfw on its own", () => {
		// Pinned as the whole clause: a bounded window around "kissing" would
		// still pass if the sentence it belongs to were rewritten.
		expect(LINK_RULES).toMatch(
			/judulnya menyebut konten seksual atau sugestif \(misalnya "hot",\s+"kissing", "sexy", bagian tubuh, atau kata seksual\), itu NSFW/,
		)
	})

	it("LINK_RULES forbids letting history or a joke label downgrade it", () => {
		expect(LINK_RULES).toMatch(
			/Riwayat percakapan, suasana channel yang guyon, atau label "candaan" TIDAK\s+menurunkan nilai pratinjau seperti itu\./,
		)
	})

	it("reaches a text-only prompt, where MEDIA_RULES is absent", () => {
		// A link post has no attachment row, so the batch is `mode: "text"` and
		// MEDIA_RULES never ships. The rule therefore has to live in LINK_RULES,
		// which is unconditional — this is the assertion that catches a future
		// move into the media block.
		clearPromptCache()
		const prompt = buildSystemPrompt({ mode: "text" })
		expect(prompt).toContain("PRATINJAU ANIMASI")
		expect(prompt).toContain("itu NSFW: status")
	})
})
