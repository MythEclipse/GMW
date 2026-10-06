/**
 * P1a verification — exercises every repository ported off Prisma against the
 * real dev-postgres, through the real Drizzle handle.
 *
 * NOT part of the unit suite: this file is deliberately not named `*.test.ts`,
 * so `vitest.config.ts`'s include globs skip it. `tests/setup-env.ts` points
 * DATABASE_URL at a dead port on purpose so a unit test can never open a pool;
 * this harness stands the handle up itself instead.
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/gmw_mod \
 *     ./node_modules/.bin/tsx tests/integration/p1a-repositories.ts
 */

import { uiStateService } from "../../src/application/ui-state/ui-state.service.js"
import {
	closeDrizzleDatabase,
	getDatabase,
	initializeDatabase,
} from "../../src/infrastructure/database/drizzle.js"
import {
	channelCulturesTable,
	messagesTable,
	termGlossaryCacheTable,
	uiStateTable,
} from "../../src/infrastructure/database/schema.js"
import { AnalysisRepository } from "../../src/infrastructure/repositories/analysis.repository.js"
import { ChatbotRepository } from "../../src/infrastructure/repositories/chatbot.repository.js"
import { HealthRepository } from "../../src/infrastructure/repositories/health.repository.js"
import { KnowledgeRepository } from "../../src/infrastructure/repositories/knowledge.repository.js"

let failures = 0

function check(name: string, condition: boolean, detail?: unknown) {
	if (condition) {
		console.log(`  ok   ${name}`)
	} else {
		failures += 1
		console.log(`  FAIL ${name}`, detail === undefined ? "" : detail)
	}
}

/**
 * Seed this harness's own fixture.
 *
 * The dev-postgres on :5433 is SHARED and live — other processes write real
 * Discord captures to it. An earlier version of this file assumed its rows
 * were already present and failed whenever something reset the database
 * underneath it. Seeding here (and keying on ids nothing else uses) makes the
 * harness self-contained and re-runnable.
 */
const FIXTURE_MESSAGE_ID = "p1a-verify-msg"
const FIXTURE_CHANNEL_ID = "p1a-verify-chan"

async function seed() {
	const db = getDatabase()
	await db
		.insert(messagesTable)
		.values({
			id: FIXTURE_MESSAGE_ID,
			guild_id: "p1a-verify-guild",
			channel_id: FIXTURE_CHANNEL_ID,
			user_id: "p1a-verify-user",
			username: "verifier",
			content: "halo dunia",
			created_at: 1000,
			metadata: JSON.stringify({ channel: { channelName: "general" } }),
		})
		.onConflictDoUpdate({
			target: messagesTable.id,
			set: {
				content: "halo dunia",
				metadata: JSON.stringify({ channel: { channelName: "general" } }),
			},
		})

	await db
		.insert(channelCulturesTable)
		.values({
			channel_id: FIXTURE_CHANNEL_ID,
			guild_id: "p1a-verify-guild",
			culture_summary: "bahasa santai",
			last_analyzed_at: 2000,
		})
		.onConflictDoUpdate({
			target: channelCulturesTable.channel_id,
			set: { culture_summary: "bahasa santai" },
		})

	await db
		.insert(termGlossaryCacheTable)
		.values({
			term: "p1a-verify-term",
			definition: "greeting",
			source_url: "http://example.invalid",
			resolved_at: 3000,
			hit_count: 5,
		})
		.onConflictDoUpdate({
			target: termGlossaryCacheTable.term,
			set: { definition: "greeting" },
		})

	await db
		.insert(uiStateTable)
		.values({ key: "p1a-verify-key", value: '"dark"', updated_at: 4000 })
		.onConflictDoUpdate({
			target: uiStateTable.key,
			set: { value: '"dark"' },
		})
}

async function main() {
	await initializeDatabase()
	await seed()

	// Built after initializeDatabase(): the repositories take an injected
	// DatabaseHandle, and constructing one calls getDatabase(), which throws
	// until the pool exists.
	const healthRepository = new HealthRepository(getDatabase())
	const analysisRepository = new AnalysisRepository(getDatabase())
	const chatbotRepository = new ChatbotRepository(getDatabase())
	const knowledgeRepository = new KnowledgeRepository(getDatabase())

	console.log("\nhealth.repository")
	const health = await healthRepository.checkDatabaseConnection()
	check("SELECT 1 reports connected", health.connected === true, health)

	console.log("\nanalysis.repository")
	// Scoped to the fixture's own guild: `search({})` legitimately matches every
	// row in a shared database, so an unscoped count would assert nothing.
	const search = await analysisRepository.search({
		q: "dunia",
		guildId: "p1a-verify-guild",
	})
	check("finds the seeded message", search.length === 1, search.length)
	check("maps content", search[0]?.content === "halo dunia", search[0]?.content)
	check(
		"coerces created_at to a number",
		typeof search[0]?.created_at === "number",
	)
	check(
		"empty query still matches (ilike %%)",
		(await analysisRepository.search({ guildId: "p1a-verify-guild" })).length >=
			1,
	)
	check(
		"non-matching query returns empty",
		(await analysisRepository.search({ q: "zzzznotfound" })).length === 0,
	)
	check(
		"guildId filter excludes other guilds",
		(await analysisRepository.search({ guildId: "p1a-no-such-guild" }))
			.length === 0,
	)

	console.log("\nknowledge.repository")
	const cultures = (
		await knowledgeRepository.listChannelCultures(50, "p1a-verify-chan")
	).filter((c) => c.channel_id === FIXTURE_CHANNEL_ID)
	check("returns the seeded culture", cultures.length === 1, cultures.length)
	check(
		"resolves channel_name from messages.metadata",
		cultures[0]?.channel_name === "general",
		cultures[0]?.channel_name,
	)
	check(
		"search matches culture_summary",
		(await knowledgeRepository.listChannelCultures(50, "bahasa santai")).some(
			(c) => c.channel_id === FIXTURE_CHANNEL_ID,
		),
	)
	check(
		"non-matching search is empty",
		(await knowledgeRepository.listChannelCultures(50, "zzzznotfound"))
			.length === 0,
	)
	const glossary = (
		await knowledgeRepository.listGlossary(50, "p1a-verify-term")
	).filter((t) => t.term === "p1a-verify-term")
	check("returns the seeded term", glossary.length === 1, glossary.length)
	check(
		"maps resolved_at to a number",
		typeof glossary[0]?.resolved_at === "number",
	)
	check(
		"search matches definition",
		(await knowledgeRepository.listGlossary(50, "greeting")).some(
			(t) => t.term === "p1a-verify-term",
		),
	)

	console.log("\nui-state.service")
	// Restore the fixture value first — this check mutates it, and the harness
	// must be re-runnable without a re-seed.
	await uiStateService.updateState({ "p1a-verify-key": "dark" })
	const before = await uiStateService.getState()
	check("reads seeded key", before["p1a-verify-key"] === "dark", before)
	const updated = await uiStateService.updateState({
		"p1a-verify-key": "light",
		"p1a-verify-extra": { a: 1 },
	})
	check(
		"upsert overwrites an existing key",
		updated["p1a-verify-key"] === "light",
		updated["p1a-verify-key"],
	)
	check(
		"upsert inserts a new key",
		JSON.stringify(updated["p1a-verify-extra"]) === '{"a":1}',
		updated["p1a-verify-extra"],
	)

	console.log("\nchatbot.repository")
	// Start from a known state: the counts below are exact. Clearing first also
	// re-exercises the delete path, so a stale row can never be mistaken for a
	// porting bug.
	await chatbotRepository.clearChatHistory("p1a-verify-user")
	await chatbotRepository.saveConversation({
		userId: "p1a-verify-user",
		userMessage: "pertama",
		botResponse: "jawab 1",
		context: { messageCount: 1 },
		timestamp: new Date("2024-01-01T00:00:00Z"),
	})
	await chatbotRepository.saveConversation({
		userId: "p1a-verify-user",
		userMessage: "kedua",
		botResponse: "jawab 2",
		context: {},
		timestamp: new Date("2024-01-02T00:00:00Z"),
	})
	const history = await chatbotRepository.getChatHistory("p1a-verify-user", 10)
	check("returns both turns", history.length === 2, history.length)
	check(
		"oldest-to-newest ordering (reversed from desc)",
		history[0]?.user_message === "pertama" &&
			history[1]?.user_message === "kedua",
		history.map((h) => h.user_message),
	)
	check(
		"limit keeps the NEWEST rows",
		(await chatbotRepository.getChatHistory("p1a-verify-user", 1))[0]
			?.user_message === "kedua",
	)
	check(
		"other users are isolated",
		(await chatbotRepository.getChatHistory("p1a-no-such-user", 10)).length ===
			0,
	)
	await chatbotRepository.clearChatHistory("p1a-verify-user")
	check(
		"clear removes the user's rows",
		(await chatbotRepository.getChatHistory("p1a-verify-user", 10)).length ===
			0,
	)

	await closeDrizzleDatabase()

	console.log(
		failures === 0
			? "\nP1a: all checks passed"
			: `\nP1a: ${failures} check(s) FAILED`,
	)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
	console.error("P1a harness threw:", err)
	process.exit(1)
})
