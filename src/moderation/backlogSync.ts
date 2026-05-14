import type { Client, Message } from "discord.js-selfbot-v13";
import { config } from "../config";
import { createChildLogger } from "../logger";
import { captureMessage } from "./messageCapture";

const logger = createChildLogger("backlog-sync");

async function syncChannelMessages(
  channel: any,
  cutoffTime: number,
): Promise<number> {
  let before: string | undefined;
  let synced = 0;
  let shouldContinue = true;

  while (shouldContinue) {
    const batch = await channel.messages.fetch({
      limit: config.BACKLOG_SYNC_BATCH_SIZE,
      ...(before ? { before } : {}),
    });

    if (batch.size === 0) break;

    const messages = Array.from(batch.values()) as Message[];
    for (const message of messages) {
      if (message.author?.bot) continue;
      if (message.createdTimestamp < cutoffTime) {
        shouldContinue = false;
        continue;
      }

      await captureMessage(message, "text");
      synced++;
    }

    before = messages[messages.length - 1]?.id;
    if (!before || batch.size < config.BACKLOG_SYNC_BATCH_SIZE) break;
  }

  return synced;
}

export async function syncBacklogMessages(
  client: Client,
): Promise<void> {
  if (!config.MONITOR_GUILD_ID) {
    logger.warn("MONITOR_GUILD_ID not configured, skipping backlog sync");
    return;
  }

  const guild = client.guilds.cache.get(config.MONITOR_GUILD_ID);
  if (!guild) {
    logger.warn(
      { guildId: config.MONITOR_GUILD_ID },
      "Monitor guild not found, skipping backlog sync",
    );
    return;
  }

  logger.info(
    { guildId: guild.id },
    "Backlog sync ready (will sync on-demand per selected channel)",
  );
}

export async function syncSelectedChannelBacklog(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<number> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    logger.warn({ guildId }, "Guild not found for backlog sync");
    return 0;
  }

  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    logger.warn({ guildId, channelId }, "Channel not found for backlog sync");
    return 0;
  }

  const cutoffTime = Date.now() - config.BACKLOG_SYNC_HOURS * 60 * 60 * 1000;
  logger.info(
    { guildId, channelId, hours: config.BACKLOG_SYNC_HOURS },
    "Starting backlog sync for selected channel",
  );

  try {
    const count = await syncChannelMessages(channel as any, cutoffTime);
    logger.info(
      { channelId, count },
      "Backlog sync completed for selected channel",
    );
    return count;
  } catch (error) {
    logger.warn(
      {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Backlog sync failed for selected channel",
    );
    return 0;
  }
}
