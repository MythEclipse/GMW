import type { Client, PermissionString } from "discord.js-selfbot-v13";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";
import type { MessageRecord } from "./types.js";

const logger = createChildLogger("auto-delete-manager");

export interface AutoDeleteResult {
  deleted: boolean;
  skipped: boolean;
  reason: string;
}

function getErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const maybeCode = (error as { code?: number | string }).code;
  const maybeStatus = (error as { status?: number | string }).status;
  return maybeCode ?? maybeStatus;
}

function isAlreadyDeletedError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 10008 || code === 404 || code === "10008" || code === "404";
}

function hasChannelMessagesApi(
  channel: unknown,
): channel is { messages: { fetch: (id: string) => Promise<{ delete: () => Promise<unknown> }> } } {
  return Boolean(
    channel &&
      typeof channel === "object" &&
      "messages" in channel &&
      (channel as { messages?: unknown }).messages &&
      typeof (channel as { messages: { fetch?: unknown } }).messages.fetch ===
        "function",
  );
}

function hasPermissionApi(
  channel: unknown,
): channel is { permissionsFor: (member: unknown) => { has: (permission: string) => boolean } | null } {
  return Boolean(
    channel &&
      typeof channel === "object" &&
      "permissionsFor" in channel &&
      typeof (channel as { permissionsFor?: unknown }).permissionsFor === "function",
  );
}

export async function attemptAutoDeleteFlaggedMessage(
  client: Client | undefined,
  message: MessageRecord,
): Promise<AutoDeleteResult> {
  if (!config.AUTO_DELETE_FLAGGED_ENABLED) {
    return { deleted: false, skipped: true, reason: "disabled" };
  }

  if (message.ai_status !== "flagged") {
    return { deleted: false, skipped: true, reason: "not_flagged" };
  }

  if (!client?.user?.id) {
    logger.warn({ messageId: message.id }, "Auto-delete skipped: client user missing");
    return { deleted: false, skipped: true, reason: "client_user_missing" };
  }

  try {
    const guild = client.guilds.cache.get(message.guild_id);
    if (!guild) {
      logger.warn(
        { messageId: message.id, guildId: message.guild_id },
        "Auto-delete skipped: guild not found",
      );
      return { deleted: false, skipped: true, reason: "guild_not_found" };
    }

    const channelId = message.thread_id ?? message.channel_id;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      logger.warn(
        { messageId: message.id, channelId },
        "Auto-delete skipped: channel not found",
      );
      return { deleted: false, skipped: true, reason: "channel_not_found" };
    }

    if (!hasPermissionApi(channel) || !hasChannelMessagesApi(channel)) {
      logger.warn(
        { messageId: message.id, channelId },
        "Auto-delete skipped: channel cannot delete messages",
      );
      return { deleted: false, skipped: true, reason: "unsupported_channel" };
    }

    const selfMember = await guild.members.fetch(client.user.id);
    const permissions = channel.permissionsFor(selfMember);
    const canManageMessages =
      permissions?.has("MANAGE_MESSAGES" as PermissionString) ?? false;

    if (!canManageMessages) {
      logger.warn(
        { messageId: message.id, channelId, userId: client.user.id },
        "Auto-delete skipped: current user lacks Manage Messages",
      );
      return { deleted: false, skipped: true, reason: "missing_manage_messages" };
    }

    if (config.AUTO_DELETE_FLAGGED_DRY_RUN) {
      logger.info(
        { messageId: message.id, channelId },
        "Auto-delete dry-run: would delete flagged message",
      );
      return { deleted: false, skipped: true, reason: "dry_run" };
    }

    const discordMessage = await channel.messages.fetch(message.id);
    await discordMessage.delete();

    logger.info(
      { messageId: message.id, channelId },
      "Auto-deleted AI-flagged message",
    );
    return { deleted: true, skipped: false, reason: "deleted" };
  } catch (error) {
    if (isAlreadyDeletedError(error)) {
      logger.info(
        { messageId: message.id, code: getErrorCode(error) },
        "Auto-delete skipped: message already deleted",
      );
      return { deleted: true, skipped: false, reason: "already_deleted" };
    }

    logger.error(
      {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
        code: getErrorCode(error),
      },
      "Auto-delete failed",
    );
    return { deleted: false, skipped: true, reason: "error" };
  }
}
