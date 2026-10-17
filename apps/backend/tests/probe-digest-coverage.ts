/**
 * PROBE — end-to-end proof that the weekly digest actually renders, by running
 * the REAL `runWeeklyDigest` against a seeded database and inspecting the embed
 * it would post.
 *
 * Why this exists. The digest builds its body from four independent SQL queries
 * and used to `Promise.all` them, so a type error in ANY one rejected the batch
 * and the digest posted NOTHING — silently, because the failure was caught and
 * logged rather than crashing the process. Two of the four were in fact broken
 * (a jsonb function called on a `text` column, and a `content` column that does
 * not exist on `moderation_actions`), so production had never received a digest
 * at all while the code looked plausible.
 *
 * Numbers-only assertions cannot catch that: the coverage figure was correct in
 * isolation, it just never reached anyone. So this probe seeds a row for every
 * section, runs the real function, and requires every section to be PRESENT in
 * the rendered embed.
 *
 * `runWeeklyDigest` posts to `config.WEBHOOK_URLS`; this points that at a
 * loopback receiver, so nothing leaves the machine.
 *
 * Run with:
 *   DATABASE_URL=postgres://.../gmw_digest DISCORD_TOKEN=x AI_LLM_API_KEY=x \
 *     pnpm exec tsx tests/probe-digest-coverage.ts
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { config } from "../src/infrastructure/config/index.js"
import { initializeDatabase } from "../src/infrastructure/database/drizzle.js"
import { runWeeklyDigest } from "../src/infrastructure/modules-gateway/monitor/digestScheduler.js"

interface DigestEmbed {
	description?: string
}

/** Substrings the rendered digest must contain, one per section it renders. */
const REQUIRED = [
	"Auto-mod coverage: 50% (3/6 runs completed)", // coverage, incl. duplicate-as-success
	"Top flagged categories:** scam (1)", // jsonb cast on the text column
	"Top flagged domains:** evil.example (1)", // message join for the URL host
	"Top flagged channels:** general (1)", // channel name from metadata
	"Top flagged categories:** —", // sentinel that must NOT appear
]

async function main(): Promise<void> {
	await initializeDatabase(config)

	const captured: DigestEmbed[] = []

	const server = createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => {
			raw += chunk
		})
		req.on("end", () => {
			const parsed = JSON.parse(raw) as { embeds?: DigestEmbed[] }
			captured.push(...(parsed.embeds ?? []))
			res.writeHead(204).end()
		})
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	config.WEBHOOK_URLS = [`http://127.0.0.1:${port}/capture`]

	await runWeeklyDigest()

	const description = captured[0]?.description ?? ""
	console.log(`captured embeds : ${captured.length}`)
	console.log("--- rendered digest ---")
	console.log(description)
	console.log("-----------------------")

	await new Promise<void>((resolve) => server.close(() => resolve()))

	const failures: string[] = []
	if (captured.length === 0) {
		failures.push("the digest posted nothing at all")
	}
	for (const needle of REQUIRED) {
		// The last entry is a negative check: a section that failed degrades to an
		// em-dash, so its presence means the section did not render.
		const isNegative = needle.endsWith("—")
		const present = description.includes(needle)
		if (isNegative ? present : !present) {
			failures.push(
				isNegative
					? `section rendered empty (found "${needle}")`
					: `missing from digest: ${needle}`,
			)
		}
	}

	if (failures.length) {
		for (const f of failures) console.error(`FAIL: ${f}`)
		process.exit(1)
	}
	console.log(`PASS — all ${REQUIRED.length - 1} sections rendered`)
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
