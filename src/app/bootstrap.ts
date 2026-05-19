import { Client } from "discord.js-selfbot-v13";
import { config } from "../config";
import { closeDatabase, initializeDatabase } from "../database/drizzle";
import { createDiscordClientOptions } from "../discordClientOptions";
import { createChildLogger } from "../logger";
import { startPendingAIAnalysisWorker } from "../moderation/aiAnalyzer";
import { syncBacklogMessages } from "../moderation/backlogSync";
import { registerMessageCapture } from "../moderation/messageCapture";
import { discordPlayer } from "../player";
import { VoiceController } from "../voiceController";
import { startWebserver } from "../webserver";
import { createGracefulShutdown } from "./shutdown";

export async function initializeApp() {
  const logger = createChildLogger("bot");

  const token = config.DISCORD_TOKEN;
  logger.info(
    { hasToken: token.length > 0, tokenLength: token.length },
    "Config loaded",
  );

  logger.info("Creating Discord client");
  const client = new Client(createDiscordClientOptions());
  const voiceController = new VoiceController(client);

  const gracefulShutdown = createGracefulShutdown({
    logger,
    closeDatabase,
    voiceController,
    discordPlayer,
    client,
  });

  try {
    logger.info("Initializing database");
    await initializeDatabase();
    logger.info({ type: config.DATABASE_TYPE }, "Database initialized");
  } catch (err) {
    logger.error({ error: err }, "Failed to initialize database");
    process.exit(1);
  }

  client.on("debug", (msg) => {
    if (
      msg.includes("[VOICE") ||
      msg.includes("[ffmpeg") ||
      msg.toLowerCase().includes("error") ||
      msg.toLowerCase().includes("stream")
    ) {
      logger.info({ debugMsg: msg }, "Discord Client Debug");
    } else if (config.VERBOSE) {
      logger.debug({ debugMsg: msg }, "Discord Client Debug");
    }
  });

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
