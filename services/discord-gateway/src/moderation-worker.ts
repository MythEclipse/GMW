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
import { createDefaultGateway } from "@/modules/ai-moderation/llmGateway.js";
import { config } from "@/shared/config/index";
import { closeDatabase, getPool } from "@/shared/database/drizzle";
import { initializeDatabase } from "@/shared/database/init";
import { runMigrations } from "@/shared/database/migrate";
import { createChildLogger } from "@/shared/logger/index";

const log = createChildLogger("moderation-worker");

async function main(): Promise<void> {
  log.info("starting moderation worker");

  if (!config.AI_ANALYSIS_ENABLED) {
    log.warn("AI_ANALYSIS_ENABLED is false — exiting without doing any work");
    return;
  }

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
  const worker = new ModerationWorker(pool, gateway, {
    claimBatchSize: config.AI_ANALYSIS_MAX_BATCH_SIZE,
    leaseMs: config.AI_ANALYSIS_PROCESSING_TIMEOUT_MS,
    llmTimeoutMs: config.AI_ANALYSIS_LLM_TIMEOUT_MS,
    // The vision pre-pass runs before the moderation call and holds the same
    // lease, so the lease assertion is against this + llmTimeoutMs.
    visionTimeoutMs: config.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS,
    idlePollMs: config.AI_ANALYSIS_POLL_INTERVAL_MS,
    maxAttempts: config.AI_ANALYSIS_MAX_ATTEMPTS,
    retryBackoffBaseMs: config.AI_ANALYSIS_RETRY_BACKOFF_MS,
    // Channels deliberately outside moderation. Still captured, never judged.
    skipChannelIds: config.AI_SKIP_ANALYSIS_CHANNEL_IDS,
    // Same, for individual threads. Needed because a thread's messages carry
    // the PARENT id in channel_id, so the channel list cannot name a thread.
    skipThreadIds: config.AI_SKIP_ANALYSIS_THREAD_IDS,
  });

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
    { workerId: worker.workerId, model: gateway.modelLabel },
    "worker ready",
  );
  await worker.start();
}

main().catch((err) => {
  log.fatal({ err }, "moderation worker failed to start");
  process.exit(1);
});
