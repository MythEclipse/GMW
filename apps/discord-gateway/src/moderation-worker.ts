/**
 * Moderation worker — its own process.
 *
 * Split from the gateway deliberately. The gateway's job is to capture Discord
 * events and persist them; it must never hold work-in-progress, because a
 * gateway restart would then strand whatever it was holding. Here the queue is
 * Postgres, correctness is enforced by `claim_messages` plus a deferred
 * trigger, and this process is disposable: kill it at any instant and nothing
 * is lost and nothing is processed twice.
 *
 * Run:  bun run src/moderation-worker.ts
 * Env:  DATABASE_URL, AI_LLM_API_KEY, AI_LLM_BASE_URL, AI_LLM_MODEL
 *
 * Scale by starting more of these — they coordinate through the database, not
 * through each other. There is no leader election and no queue broker.
 */

import { ModerationWorker } from "@/modules/ai-moderation/index.js";
import { KbbiDictionary } from "@/modules/ai-moderation/kbbiDictionary.js";
import { createDefaultGateway } from "@/modules/ai-moderation/llmGateway.js";
import { ModerationMemoryBank } from "@/modules/ai-moderation/memoryBank.js";
import { config } from "@/shared/config/index";
import { closeDatabase, getPool } from "@/shared/database/drizzle";
import { initializeDatabase } from "@/shared/database/init";
import { runMigrations } from "@/shared/database/migrate";
import { createChildLogger } from "@/shared/logger/index";

const log = createChildLogger("moderation-worker");

async function main(): Promise<void> {
  log.info("starting moderation worker");

  // Own the schema for this process. The gateway also migrates on boot; both
  // use the same idempotent runner, so a race is a no-op rather than a
  // conflict.
  //
  // runMigrations() opens a pool, migrates, and CLOSES that pool before
  // returning. getPool() afterwards throws "Database not initialized" — which
  // is why this ordering is not negotiable: re-open the pool here, and close it
  // again in the shutdown path.
  await runMigrations();
  await initializeDatabase(config);

  const pool = getPool();
  const gateway = createDefaultGateway();
  // Hindsight supplies what the guild already knows about these channels.
  // Every failure inside it degrades to an ordinary batch, so an unreachable
  // instance costs context, not verdicts.
  const memory = ModerationMemoryBank.fromConfig();
  log.info(
    { bank: config.AI_MEMORY_BANK_ID, baseUrl: config.AI_MEMORY_BASE_URL },
    "hindsight memory enabled for moderation context",
  );
  // KBBI grounds the model on what Indonesian words actually mean, so a slang
  // term is judged from its dictionary sense instead of the model's guess. An
  // unreachable dictionary costs grounding, not verdicts.
  const dictionary = KbbiDictionary.fromConfig();
  log.info(
    { baseUrl: config.AI_DICTIONARY_BASE_URL },
    "kbbi dictionary enabled for word grounding",
  );
  const worker = new ModerationWorker(
    pool,
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
    memory,
    dictionary,
  );

  let shuttingDown = false;
  const stop = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal, stats: worker.stats }, "shutting down");
    try {
      // Releases this worker's claims so a peer can take over immediately
      // rather than waiting out the lease.
      await worker.stop();
    } catch (err) {
      log.error({ err }, "failed to release claims cleanly");
    }
    try {
      await closeDatabase();
    } catch (err) {
      log.error({ err }, "failed to close database");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  // A rejection that reaches here would otherwise be silent until the next
  // batch happened to fail again.
  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "unhandled rejection in moderation worker");
  });

  log.info(
    {
      workerId: worker.workerId,
      model: gateway.modelLabel,
      memory: config.AI_MEMORY_BASE_URL,
      dictionary: config.AI_DICTIONARY_BASE_URL,
    },
    "worker ready",
  );
  await worker.start();
}

main().catch((err) => {
  log.fatal({ err }, "moderation worker failed to start");
  process.exit(1);
});
