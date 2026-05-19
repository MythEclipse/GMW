import type { Client } from "discord.js-selfbot-v13";
import type { closeDatabase } from "../database/drizzle";
import type { createChildLogger } from "../logger";
import type { discordPlayer } from "../player";
import type { VoiceController } from "../voiceController";

type Logger = ReturnType<typeof createChildLogger>;
type CloseDatabase = typeof closeDatabase;
type DiscordPlayer = typeof discordPlayer;

export interface GracefulShutdownOptions {
  logger: Logger;
  closeDatabase: CloseDatabase;
  voiceController: VoiceController;
  discordPlayer: DiscordPlayer;
  client: Client;
}

export function createGracefulShutdown(options: GracefulShutdownOptions) {
  let isShuttingDown = false;

  return async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
      options.logger.warn(`Already shutting down, ignoring ${signal}`);
      return;
    }

    isShuttingDown = true;
    options.logger.info({ signal }, "Graceful shutdown initiated");

    try {
      options.logger.info("Closing database...");
      await options.closeDatabase();
      options.logger.info("Database closed");

      options.logger.info("Stopping voice connection...");
      await options.voiceController.disconnect();

      options.logger.info("Pausing player...");
      options.discordPlayer.pause();

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
