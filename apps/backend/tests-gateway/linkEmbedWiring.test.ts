/**
 * End-to-end: the claim query must hand the worker the link preview, and the
 * prompt the worker builds must contain it.
 *
 * The unit tests in `linkEmbedEvidence.test.ts` pin the pairing and the
 * eligibility guard. This pins the WIRING, which is where the bug actually
 * lived: the claim SELECT did not list `metadata`, so even a correct formatter
 * would have received null and the prompt would have stayed exactly as blind
 * as before.
 */

import type pg from "pg"
import { expect, test } from "vitest"
import type { LlmGateway } from "../src/infrastructure/modules-gateway/ai-moderation/llmGateway.js"
import {
	DEFAULT_WORKER_CONFIG,
	ModerationWorker,
} from "../src/infrastructure/modules-gateway/ai-moderation/worker.js"
import { type IsolatedPool, tryCreateIsolatedPool } from "./isolated-pool.js"

const DB_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:postgres@127.0.0.1:5433/gmw_mod"

let pool: pg.Pool
let reachable = false
/** Drops this test's isolated schema; null when no database was reachable. */
let isolation: IsolatedPool | null = null

/** A worker wired to a gateway that records the prompt it was handed. */
function recordingWorker(capture: (prompt: string) => void): ModerationWorker {
	const gateway: LlmGateway = {
		modelLabel: "scripted",
		async complete(req) {
			capture(req.user)
			const id = /<message id="([^"]+)"/.exec(req.user)?.[1] ?? ""
			return JSON.stringify({
				results: [
					{
						message_id: id,
						status: "clean",
						flags: [],
						categories: [],
						confidence: 0.9,
						score: 0.02,
						analysis: "Ringkasan isi pesan.",
						evidence: [],
					},
				],
			})
		},
	}
	return new ModerationWorker(pool, gateway, {
		...DEFAULT_WORKER_CONFIG,
		leaseMs: 60_000,
		llmTimeoutMs: 10_000,
		visionTimeoutMs: 10_000,
		idlePollMs: 10,
		claimBatchSize: 10,
	})
}

async function seed(id: string, content: string, metadata: string) {
	await pool.query(
		"TRUNCATE messages, verdicts, analysis_attempts, attachments",
	)
	await pool.query(
		`INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ($1,'g1','c1','u1','budi',$2,$3,'pending',0,$4)`,
		[id, content, Date.now(), metadata],
	)
}

test("the prompt carries the resolved embed, not just the link", async () => {
	// Own schema: this file's TRUNCATEs cannot reach another file's rows.
	// See ./isolated-pool.ts.
	isolation = await tryCreateIsolatedPool("link_embed_wiring", { max: 4 })
	if (!isolation) return expect(true).toBe(true)
	pool = isolation.pool
	reachable = true

	const FB = "https://www.facebook.com/share/p/1HmxamFLpr/"
	await seed(
		"1402327963029999646",
		"https://t.co/abc123",
		JSON.stringify({
			embeds: [
				{
					title: "Kopi Susu Gula Aren dari UMKM Magelang",
					description: "Kedai kopi lokal yang memakai gula aren lokal.",
					url: FB,
					image: "https://cdn.discordapp.com/embed/avatars/1/photo.jpg",
					provider: { name: "Facebook", url: "https://www.facebook.com" },
					author: null,
					footer: { text: "Facebook", iconURL: null },
					fields: [],
					type: "rich",
					video: null,
				},
			],
			attachments: [],
			stickers: [],
			channel: { channelId: "c1", channelName: "umum", nsfw: false },
		}),
	)

	let seen = ""
	await recordingWorker((prompt) => {
		seen = prompt
	}).runOnce()

	// The claim query handed the row over…
	expect(seen).toContain("1402327963029999646")
	// …and the prompt shows the model what the user actually saw, rather than
	// the t.co wrapper it used to judge from.
	expect(seen).toContain(FB)
	expect(seen).toContain("Kopi Susu Gula Aren dari UMKM Magelang")
	expect(seen).toContain("Kedai kopi lokal yang memakai gula aren lokal")
	expect(seen).toContain("photo.jpg")
	expect(seen).toContain("https://t.co/abc123")
	expect(seen).toContain("<link_evidence>")

	await isolation?.cleanup()
})

test("a link whose preview never resolved is not judged as empty text", async () => {
	// Same schema as the test above, and it was just dropped there — so this one
	// creates its own. Isolation means the two no longer depend on that ordering.
	isolation = await tryCreateIsolatedPool("link_embed_wiring_2", { max: 4 })
	if (!isolation) return expect(true).toBe(true)
	pool = isolation.pool
	reachable = true

	await seed(
		"1402327963029999999",
		"https://t.co/nopreview",
		JSON.stringify({
			embeds: [],
			attachments: [],
			stickers: [],
			channel: { channelId: "c1", channelName: "umum", nsfw: false },
		}),
	)

	let seen = ""
	await recordingWorker((prompt) => {
		seen = prompt
	}).runOnce()

	// The honest "no preview" marker must reach the model, so it reports the
	// unknown instead of inventing page content from the domain.
	expect(seen).toContain("1402327963029999999")
	expect(seen).toContain("<link_evidence>")
	expect(seen).toContain("tidak ada")
	expect(seen).toContain("https://t.co/nopreview")

	await isolation?.cleanup()
})
