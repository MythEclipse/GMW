/**
 * The `<message author="…">` attribute, and the rules that govern it.
 *
 * WHY THIS FILE EXISTS
 *
 * Both subjects used to live in `memoryBank.test.ts`, because the author
 * mapping was written for the Hindsight bank: a recall query is prose about
 * names, so the prompt had to carry every name a person could be referred to
 * by. The Hindsight memory feature is gone (2026-10-08), but the author
 * attribute it motivated is load-bearing on its own — it is the only thing in
 * the prompt that says WHO is speaking, and `policy.ts` has a whole rule block
 * ("NAMA PENGGUNA — BUKAN BUKTI PESAN") about not deleting a message over its
 * sender's name.
 *
 * The other subject is the system prompt's cache key. `buildSystemPrompt` is
 * memoised, so a toggle left out of the key silently serves the wrong prompt:
 * the rules describing a block arrive for a prompt that has none, or a
 * prompt that has the block ships without the rules that explain it. That is
 * the failure the cache key exists to prevent, and it is worth pinning now that
 * only one toggle (`history`) remains.
 */

import { describe, expect, it } from "vitest"
import {
	buildSystemPrompt,
	clearPromptCache,
	HISTORY_RULES,
} from "../src/infrastructure/modules-gateway/ai-moderation/policy.js"
import {
	extractPromptAuthor,
	formatAuthorForPrompt,
} from "../src/infrastructure/modules-gateway/message-capture/messageMetadata.js"

// ─── Identity mapping ────────────────────────────────────────────────────────

it("identity keeps the global username AND the server nickname", () => {
	const author = extractPromptAuthor(
		"123456789012345678",
		JSON.stringify({
			author: {
				id: "123456789012345678",
				username: "zulfik_dev",
				globalName: "Zulfikar Pratama",
				tag: "zulfik_dev#0042",
				bot: false,
			},
			member: { nickname: "Zul", displayName: "Zul" },
		}),
	)

	expect(author.userId).toBe("123456789012345678")
	expect(author.username).toBe("zulfik_dev")
	expect(author.globalName).toBe("Zulfikar Pratama")
	// The server-scoped name. A moderation queue shows the nickname, so a
	// verdict that says "the nickname is offensive" must be checkable against it.
	expect(author.serverName).toBe("Zul")
})

it("a missing nickname falls back to the server display name", () => {
	const author = extractPromptAuthor(
		"999",
		JSON.stringify({
			author: { username: "budi" },
			member: { displayName: "Budi S." },
		}),
	)
	expect(author.serverName).toBe("Budi S.")
})

it("absent metadata yields nulls, never an invented name", () => {
	for (const input of [null, undefined, "", "not json", "[]", "null"]) {
		const author = extractPromptAuthor("555", input)
		expect(author.username).toBeNull()
		expect(author.globalName).toBeNull()
		expect(author.serverName).toBeNull()
		// The id is always known, and that is enough to identify the author.
		expect(author.userId).toBe("555")
	}
})

// ─── The rendered attribute ──────────────────────────────────────────────────

it("the author attribute carries every name as the join key", () => {
	const who = formatAuthorForPrompt({
		userId: "123",
		username: "zulfik_dev",
		globalName: "Zulfikar Pratama",
		serverName: "Zul",
		tag: null,
	})
	expect(who).toContain("zulfik_dev")
	expect(who).toContain("Zulfikar Pratama")
	expect(who).toContain("Zul")
	expect(who).toContain("123")
})

it("a display name cannot break out of the attribute", () => {
	const who = formatAuthorForPrompt({
		userId: "1",
		username: 'evil" onload="alert(1)',
		globalName: null,
		serverName: null,
		tag: null,
	})
	expect(who).not.toContain('" onload')
	expect(who).toContain("&quot;")
})

it("an id-only author still renders a usable attribute", () => {
	const who = formatAuthorForPrompt(extractPromptAuthor("777", null))
	expect(who).toBe("777")
})

it("a name repeated across the three fields is not repeated in the attribute", () => {
	const who = formatAuthorForPrompt({
		userId: "1",
		username: "budi",
		globalName: "budi",
		serverName: "budi",
		tag: null,
	})
	expect(who).toBe("budi | 1")
})

// ─── The rules about the name ────────────────────────────────────────────────

it("the prompt says the author attribute is not message content", () => {
	// The block that exists because the model cited a nickname as evidence and
	// the message got deleted over it. Without this rule the attribute invites
	// a verdict about the person rather than the text.
	const system = buildSystemPrompt({ mode: "text" })
	expect(system).toContain("NAMA PENGGUNA")
	expect(system).toContain("BUKAN BUKTI PESAN")
	expect(system).toContain("offensive_nickname")
	expect(system).toContain("reset_nickname")
})

// ─── Prompt cache key ────────────────────────────────────────────────────────

describe("prompt cache key", () => {
	it("history rules appear only when the prompt carries a history block", () => {
		clearPromptCache()
		const withHistory = buildSystemPrompt({ mode: "text", history: true })
		const without = buildSystemPrompt({ mode: "text", history: false })
		expect(withHistory).toContain("RIWAYAT PERCAKAPAN")
		expect(without).not.toContain("RIWAYAT PERCAKAPAN")
		// And it must not be served from another cache entry: describing a block
		// that is absent is worse than omitting the rule.
		expect(without).toBe(buildSystemPrompt({ mode: "text", history: false }))
	})

	it("the history rules forbid judging the context block", () => {
		const rules = HISTORY_RULES.replace(/\s+/g, " ")
		expect(rules).toContain("KONTEKS")
		// Returning a verdict for a history row would re-apply a decision to a
		// message that was already judged, or delete it twice.
		expect(rules).toContain(
			"JANGAN kembalikan entri results untuk pesan di <conversation_history>",
		)
		expect(rules).toContain("Hanya pesan di blok utama yang dinilai")
	})

	it("a prompt never mentions a block it does not carry", () => {
		clearPromptCache()
		const without = buildSystemPrompt({ mode: "text" })
		expect(without).not.toContain("<memory_context>")
		expect(without).not.toContain("<conversation_history>")
		expect(without).not.toContain("MEMORI")
	})
})
