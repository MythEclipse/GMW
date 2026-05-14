import "./mock-crc";
import "libsodium-wrappers";
import "@snazzah/davey";
import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { config } from "./config";
import { initializeDatabase, closeDatabase } from "./database/drizzle";
import { createChildLogger } from "./logger";
import { startPendingAIAnalysisWorker } from "./moderation/aiAnalyzer";
import { syncBacklogMessages } from "./moderation/backlogSync";
import { registerMessageCapture } from "./moderation/messageCapture";
import { discordPlayer } from "./player";
import { VoiceController } from "./voiceController";
import { startWebserver } from "./webserver";

const logger = createChildLogger("bot");

const token = config.DISCORD_TOKEN;
logger.info(
  { hasToken: token.length > 0, tokenLength: token.length },
  "Config loaded",
);

logger.info("Creating Discord client");
const client = new Client();
const voiceController = new VoiceController(client);

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn(`Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated");

  try {
    logger.info("Closing database...");
    await closeDatabase();
    logger.info("Database closed");

    logger.info("Stopping voice connection...");
    await voiceController.disconnect();

    logger.info("Pausing player...");
    discordPlayer.pause();

    logger.info("Destroying Discord client...");
    try {
      client.destroy();
    } catch (err) {
      logger.warn({ error: err }, "Error destroying client");
    }

    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (err) {
    logger.error({ error: err }, "Error during graceful shutdown");
    process.exit(1);
  }
}

async function initializeApp() {
  try {
    logger.info("Initializing database");
    await initializeDatabase();
    logger.info({ type: config.DATABASE_TYPE }, "Database initialized");
  } catch (err) {
    logger.error({ error: err }, "Failed to initialize database");
    process.exit(1);
  }

  client.on("ready", async () => {
    logger.info({ user: client.user?.tag }, "Bot logged in");
    registerMessageCapture(client);
    startPendingAIAnalysisWorker();
    syncBacklogMessages(client).catch((error) => {
      logger.warn({ error }, "Backlog sync failed");
    });
    await startWebserver(config.WEBSERVER_PORT, client, voiceController);
  });

  client.on("error", (err) => {
    logger.error({ error: err }, "Client error");
  });

  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM");
  });

  process.on("uncaughtException", (err) => {
    logger.error({ error: err }, "Uncaught exception");
    gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error({ reason, promise }, "Unhandled rejection");
    gracefulShutdown("unhandledRejection");
  });

  logger.info("Calling Discord client.login");
  client
    .login(token)
    .then(() => {
      logger.info("Discord client.login resolved");
    })
    .catch((error) => {
      logger.error({ error }, "Discord client.login failed");
    });
}

initializeApp().catch((error) => {
  logger.error({ error }, "Failed to initialize app");
  process.exit(1);
});
