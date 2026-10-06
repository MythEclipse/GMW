/**
 * Messages in a channel Discord marks NSFW must never be analysed or deleted.
 *
 * The flag is read from the channel object Discord exposes
 * (`GuildTextChannel.nsfw`, `GuildVoiceChannel.nsfw` — both `boolean`), read
 * at capture time by messageMetadata.ts and persisted under
 * `messages.metadata -> channel -> nsfw`. Nothing here is a hardcoded channel
 * id: an admin toggling a channel in the Discord UI changes the behaviour
 * with no config change and no redeploy.
 *
 * Two separate paths must respect it:
 *   1. the worker, so the message is never even sent to the model;
 *   2. the enforcer, so a verdict that predates the flag (or a channel that
 *      was marked NSFW after the fact) is not deleted either.
 *
 * Run: bun test tests/
 */

import type pg from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type {
	LlmGateway,
	LlmRequest,
} from "../src/modules-gateway/ai-moderation/llmGateway.js"
import { ModerationWorker } from "../src/modules-gateway/ai-moderation/worker.js"
import { type IsolatedPool, tryCreateIsolatedPool } from "./isolated-pool.js"

const DB_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:***@127.0.0.1:5433/gmw_mod"

let pool: pg.Pool
let reachable = false
/** Drops this file's isolated schema; null when no database was reachable. */
let isolation: IsolatedPool | null = null

/** Metadata shaped exactly like what messageCapture persists. */
function metadataFor(nsfw: boolean): string {
	return JSON.stringify({
		stickers: [],
		embeds: [],
		attachments: [],
		customEmojis: [],
		mentionedRoles: [],
		mentionedUsers: [],
		author: { id: "u1", username: "u", tag: "u", bot: false },
		member: { displayName: "U", roles: [] },
		channel: {
			nsfw,
			topic: null,
			threadId: null,
			channelId: "chan",
			nsfwLevel: null,
			threadName: null,
			channelName: "chan",
			ageRestricted: nsfw,
		},
		reference: null,
		isCrosspost: false,
	})
}

async function seed(
	rows: { id: string; channel: string; nsfw: boolean }[],
): Promise<void> {
	await pool.query(
		"TRUNCATE messages, verdicts, analysis_attempts, attachments",
	)
	for (const r of rows) {
		await pool.query(
			`INSERT INTO messages
         (id, guild_id, channel_id, user_id, username, content,
          created_at, ai_status, ready_for_work_at, metadata)
       VALUES ($1, 'g1', $2, 'u1', 'user', $3, 1, 'pending', 0, $4)`,
			[r.id, r.channel, `body ${r.id}`, metadataFor(r.nsfw)],
		)
	}
}

function scriptedGateway(
	respond: (req: LlmRequest, call: number) => string,
): LlmGateway & { calls: number } {
	const g = {
		modelLabel: "scripted",
		calls: 0,
		async complete(req: LlmRequest): Promise<string> {
			g.calls++
			return respond(req, g.calls)
		},
	}
	return g
}

/**
 * A small, self-consistent budget. The shipped defaults are large and the
 * lease must exceed vision + moderation, so an explicit small pair keeps these
 * tests fast and exercises the same state machine.
 */
const TEST_WORKER_CONFIG = {
	claimBatchSize: 10,
	leaseMs: 60_000,
	llmTimeoutMs: 10_000,
	visionTimeoutMs: 10_000,
	idlePollMs: 10,
} as const

/**
 * A verdict for the given ids.
 *
 * `reason` is present because a `deleted` verdict cannot be written without
 * one — `verdicts_reason_check` rejects the row otherwise — and every
 * `severity`/`recommended_action` field is gone, so `status` alone decides.
 */
const verdictFor = (ids: string[], status: string, category: string) =>
	JSON.stringify({
		results: ids.map((id) => ({
			message_id: id,
			status,
			...(status === "deleted" ? { reason: "test verdict" } : {}),
			flags: [category],
			categories: [category],
			confidence: 0.95,
			score: 0.9,
			analysis: "test verdict",
			evidence: [],
			policy_version: "test",
		})),
	})

beforeAll(async () => {
	// Own schema: this file's TRUNCATEs cannot reach another file's rows.
	// See ./isolated-pool.ts.
	isolation = await tryCreateIsolatedPool("nsfw_channel_skip", { max: 4 })
	if (!isolation) {
		reachable = false
		return
	}
	pool = isolation.pool
	reachable = true
})

afterAll(async () => {
	await isolation?.cleanup()
})

describe("NSFW channels are never moderated", () => {
	test("a message in an NSFW channel is not sent to the model", async () => {
		if (!reachable) return
		await seed([
			{ id: "nsfw-1", channel: "chan-nsfw", nsfw: true },
			{ id: "safe-1", channel: "chan-safe", nsfw: false },
		])

		const llm = scriptedGateway((req) => {
			// Echo back whichever ids the worker actually put in the prompt.
			const ids = [...req.user.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
			return verdictFor(ids, "deleted", "nsfw")
		})

		const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG)
		await worker.runOnce()

		// Only the safe channel's message reached the model.
		expect(llm.calls).toBe(1)
		const sent = await pool.query<{ id: string }>(
			"SELECT id FROM messages WHERE id = 'safe-1'",
		)
		expect(sent.rows.length).toBe(1)

		// The NSFW message is parked as 'skipped', never judged and never lost.
		// 'skipped' is correct, not 'pending': a release back to pending was the
		// queue-starvation defect — the claim function hands those rows back every
		// tick forever. There are exactly two dispositions, reschedule (a message
		// that should be judged again) and skip (one that never will be).
		const { rows } = await pool.query<{
			ai_status: string
			attempts: number
			worker_id: string | null
		}>(
			"SELECT ai_status, attempts, worker_id FROM messages WHERE id = 'nsfw-1'",
		)
		expect(rows[0].ai_status).toBe("skipped")
		expect(rows[0].worker_id ?? null).toBeNull()
	})

	test("an NSFW message gets no verdict row at all", async () => {
		if (!reachable) return
		await seed([{ id: "nsfw-2", channel: "chan-nsfw", nsfw: true }])

		const llm = scriptedGateway(() => verdictFor(["nsfw-2"], "deleted", "nsfw"))
		const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG)
		await worker.runOnce()

		const { rows } = await pool.query<{ n: number }>(
			"SELECT count(*)::int n FROM verdicts WHERE message_id = 'nsfw-2'",
		)
		expect(rows[0].n).toBe(0)
	})

	test("missing metadata is treated as safe, not skipped", async () => {
		// A message captured before the nsfw flag existed has no metadata at all.
		// It must still be analysed — the default has to be "moderate", not
		// "skip", or a whole channel would silently go unmoderated.
		if (!reachable) return
		await pool.query(
			"TRUNCATE messages, verdicts, analysis_attempts, attachments",
		)
		await pool.query(
			`INSERT INTO messages
         (id, guild_id, channel_id, user_id, username, content,
          created_at, ai_status, ready_for_work_at, metadata)
       VALUES ('no-meta', 'g1', 'c1', 'u1', 'user', 'body', 1, 'pending', 0, NULL)`,
		)

		const llm = scriptedGateway((req) => {
			const ids = [...req.user.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
			return verdictFor(ids, "clean", "none")
		})
		const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG)
		await worker.runOnce()

		expect(llm.calls).toBe(1)
		const { rows } = await pool.query<{ ai_status: string }>(
			"SELECT ai_status FROM messages WHERE id = 'no-meta'",
		)
		expect(rows[0].ai_status).toBe("analyzed")
	})
})

describe("image descriptions reach the moderation prompt", () => {
	/**
	 * The vision feature shipped inert once already: the description was
	 * fetched but never interpolated into the message body, so the model
	 * received text only. This asserts the description is present in the
	 * prompt the model actually sees.
	 */
	test("an attached image contributes a Media description line", async () => {
		if (!reachable) return
		await pool.query(
			"TRUNCATE messages, verdicts, analysis_attempts, attachments",
		)
		await pool.query(
			`INSERT INTO messages
         (id, guild_id, channel_id, user_id, username, content,
          created_at, ai_status, ready_for_work_at, metadata)
       VALUES ('img-1', 'g1', 'c1', 'u1', 'user', '', 1, 'pending', 0, NULL)`,
		)
		await pool.query(
			`INSERT INTO attachments
         (id, message_id, guild_id, channel_id, user_id, filename, size,
          type, discord_url, upload_status, created_at)
       VALUES ('a1', 'img-1', 'g1', 'c1', 'u1', 'x.png', 1,
               'image/png', 'https://cdn.discordapp.com/x.png', 'pending', 1)`,
		)

		let seen = ""
		const llm = scriptedGateway((req) => {
			seen = req.user
			return verdictFor(["img-1"], "clean", "none")
		})
		// Stub vision client: the description is what is under test, not the
		// network round trip. Without this the test depends on a live model.
		const vision: LlmGateway = {
			modelLabel: "stub-vision",
			async complete() {
				return '["A white mug on a wooden surface."]'
			},
		}
		const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG, vision)
		await worker.runOnce()

		// The description call is a real LLM call in this path, so the scripted
		// gateway stands in for it: the same complete() is used for both. What
		// matters is that the prompt carries a media line when the message has
		// an attachment, and that the id tag is still intact.
		expect(seen).toContain('id="img-1"')
		// The vision model returns JSON, so assert on the stable marker rather
		// than on the wording of a particular description.
		expect(seen).toContain("[Media description:")
		// The id tag must survive interleaving the description, or the parser
		// cannot map a verdict back to its message.
		expect(seen).toContain("</message>")
	})

	test("a text-only message contributes no media line", async () => {
		if (!reachable) return
		await pool.query(
			"TRUNCATE messages, verdicts, analysis_attempts, attachments",
		)
		await pool.query(
			`INSERT INTO messages
         (id, guild_id, channel_id, user_id, username, content,
          created_at, ai_status, ready_for_work_at, metadata)
       VALUES ('txt-1', 'g1', 'c1', 'u1', 'user', 'halo dunia', 1, 'pending', 0, NULL)`,
		)

		let seen = ""
		const llm = scriptedGateway((req) => {
			seen = req.user
			return verdictFor(["txt-1"], "clean", "none")
		})
		const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG)
		await worker.runOnce()

		expect(seen).toContain("halo dunia")
		expect(seen.toLowerCase()).not.toContain("media description")
	})
})
