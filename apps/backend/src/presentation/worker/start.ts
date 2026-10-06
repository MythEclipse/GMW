/**
 * The moderation worker, as a function instead of a second process.
 *
 * ## What did not change
 *
 * The queue is still Postgres. `claim_messages()` plus a deferred trigger still
 * guarantee that no two workers ever hold the same row, the lease still
 * outlives the worst-case batch, and a worker killed at any instant still loses
 * nothing. Two copies of GMW can run at once and coordinate through the
 * database exactly as two copies of the old separate worker did. That is the
 * property the process split existed to protect, and it is why merging the
 * processes is safe.
 *
 * ## What changed
 *
 * It is started by `src/index.ts` after the HTTP surface and the Discord client,
 * and its failure is non-fatal — see the entrypoint for why. It returns a stop
 * function instead of installing its own signal handlers, because the process
 * now has one shutdown path.
 *
 * Env: DATABASE_URL, AI_LLM_API_KEY, AI_LLM_BASE_URL, AI_LLM_MODEL
 */

import { config } from "../../infrastructure/config/index.js"
import { getDrizzlePool } from "../../infrastructure/database/drizzle.js"
import { runMigrations } from "../../infrastructure/database/migrate.js"
import { createChildLogger } from "../../infrastructure/logger/index.js"
import { ModerationWorker } from "../../infrastructure/modules-gateway/ai-moderation/index.js"
import { KbbiDictionary } from "../../infrastructure/modules-gateway/ai-moderation/kbbiDictionary.js"
import { createDefaultGateway } from "../../infrastructure/modules-gateway/ai-moderation/llmGateway.js"
import { ModerationMemoryBank } from "../../infrastructure/modules-gateway/ai-moderation/memoryBank.js"

const log = createChildLogger("moderation-worker")

/**
 * Run migrations, build the worker, and start its claim loop.
 *
 * Returns a stop function that releases this worker's claims so a peer can take
 * over immediately rather than waiting out the lease.
 */
export async function startModerationWorker(): Promise<() => Promise<void>> {
	// Own the schema for this process. The Discord capture path also migrates on
	// boot; both use the same idempotent runner, so a race is a no-op rather than
	// a conflict.
	await runMigrations()

	const gateway = createDefaultGateway()
	const worker = new ModerationWorker(
		getDrizzlePool(),
		gateway,
		{
			claimBatchSize: config.AI_ANALYSIS_MAX_BATCH_SIZE,
			leaseMs: config.AI_ANALYSIS_PROCESSING_TIMEOUT_MS,
			llmTimeoutMs: config.AI_ANALYSIS_LLM_TIMEOUT_MS,
			// The vision pre-pass runs before the moderation call and holds the same
			// lease, so the lease assertion is against this + llmTimeoutMs.
			visionTimeoutMs: config.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS,
			idlePollMs: config.AI_ANALYSIS_POLL_INTERVAL_MS,
			maxAttempts: config.AI_ANALYSIS_MAX_ATTEMPTS,
			retryBackoffBaseMs: config.AI_ANALYSIS_RETRY_BACKOFF_MS,
			// Preceding messages shown alongside each judged one, so "balasan itu"
			// has a referent. 0 turns the block off; it is not a quality dial.
			contextWindow: config.AI_MODERATION_CONTEXT_WINDOW,
			// Channels deliberately outside moderation. Still captured, never judged.
			skipChannelIds: config.AI_SKIP_ANALYSIS_CHANNEL_IDS,
			// Same, for individual threads. Needed because a thread's messages carry
			// the PARENT id in channel_id, so the channel list cannot name a thread.
			skipThreadIds: config.AI_SKIP_ANALYSIS_THREAD_IDS,
			// Same, for high-volume bots (Jockie Music's now-playing embeds). The
			// env var was declared and read by nothing until now, so every one of
			// those embeds paid a full analysis cycle per batch, forever.
			skipUserIds: config.AI_SKIP_ANALYSIS_USER_IDS,
			// Ceiling on the vision pre-pass fan-out. Uncapped, a 40-message image
			// batch opened 40 simultaneous vision calls and the provider throttled
			// the batch.
			visionConcurrency: config.AI_LLM_MEDIA_MAX_CONCURRENT,
		},
		undefined,
		// Hindsight supplies what the guild already knows about these channels.
		// Every failure inside it degrades to an ordinary batch, so an unreachable
		// instance costs context, not verdicts.
		ModerationMemoryBank.fromConfig(),
		// KBBI grounds the model on what Indonesian words actually mean, so a slang
		// term is judged from its dictionary sense instead of the model's guess. An
		// unreachable dictionary costs grounding, not verdicts.
		KbbiDictionary.fromConfig(),
	)

	log.info(
		{
			workerId: worker.workerId,
			model: gateway.modelLabel,
			memory: config.AI_MEMORY_BASE_URL,
			bank: config.AI_MEMORY_BANK_ID,
			dictionary: config.AI_DICTIONARY_BASE_URL,
		},
		"worker ready",
	)

	await worker.start()

	return async () => {
		log.info({ stats: worker.stats }, "releasing claims")
		await worker.stop()
	}
}
