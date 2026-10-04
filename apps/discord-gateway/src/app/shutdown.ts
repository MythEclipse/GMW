import type { Client } from "discord.js-selfbot-v13";
import type { createChildLogger } from "@/shared/logger/index";
import type { CommandHandler } from "../modules/command-handler/commandHandler.js";
import type { EventBroadcaster } from "../modules/event-broadcaster/index.js";
import type { stopMetricsServer } from "../modules/gateway-metrics/index.js";
import type { closeDatabase } from "../shared/database/drizzle.js";

type Logger = ReturnType<typeof createChildLogger>;
type CloseDatabase = typeof closeDatabase;
type StopMetricsServer = typeof stopMetricsServer;

export interface GracefulShutdownOptions {
  logger: Logger;
  closeDatabase: CloseDatabase;
  client: Client;
  eventBroadcaster: EventBroadcaster;
  commandHandler: CommandHandler;
  stopMetricsServer?: StopMetricsServer;
}

export type GracefulShutdown = (signal: string) => Promise<void>;

/** Create a shutdown handler that can only be triggered once. */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdown {
  let isShuttingDown = false;

  return async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      options.logger.warn(`Already shutting down, ignoring ${signal}`);
      return;
    }

    isShuttingDown = true;
    options.logger.info({ signal }, "Graceful shutdown initiated");

    try {
      options.stopMetricsServer?.();

      // 1. Close Redis/pubsub
      options.logger.info("Closing event broadcaster...");
      await options.eventBroadcaster.close();

      options.logger.info("Closing command handler...");
      await options.commandHandler.close();

      // NOTE: there is no worker pool to tear down here. Moderation runs in
      // its own process (apps/discord-gateway/src/moderation-worker.ts),
      // and its queue lives in Postgres. This gateway only captures messages;
      // it holds no moderation state, so a gateway shutdown can never strand
      // an in-flight analysis. The worker releases its own leases on SIGTERM,
      // and anything it fails to release is reclaimed when its lease expires.
      options.logger.info("No in-process moderation state to release");

      // 2. DB pool
      options.logger.info("Closing database...");
      await options.closeDatabase();
      options.logger.info("Database closed");

      options.logger.info("Destroying Discord client...");
      try {
        options.client.destroy();
      } catch (err) {
        options.logger.warn({ error: err }, "Error destroying client");
      }

      options.logger.info("Graceful shutdown completed");
      process.exit(0);
    } catch (err) {
      options.logger.error({ error: err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };
}
