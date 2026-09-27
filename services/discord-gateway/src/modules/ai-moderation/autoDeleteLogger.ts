/**
 * Channel logging for auto-delete.
 *
 * Ported from the pre-rewrite `autoDeleteLogger.ts`. The only change is where
 * the status/severity come from: the old code read `message.ai_status` and
 * `message.ai_severity`, which after the rewrite no longer describe the
 * judgement. They now come from the verdict row.
 */
import type { Guild } from "discord.js-selfbot-v13";
import { config } from "../../shared/config/index.js";
import { createChildLogger } from "../../shared/logger/index.js";
import type { MessageLike, VerdictLike } from "./autoDeleteEligibility.js";

interface ChannelWithSend {
  send: (content: string | object, options?: unknown) => Promise<unknown>;
}

const logger = createChildLogger("auto-delete-logger");

/**
 * Post a log message about the auto-deletion to the configured moderation log
 * channel. No-op when AUTO_DELETE_LOG_CHANNEL_ID is unset. Failures are
 * warnings only — losing the log line must never fail the deletion.
 */
export async function logDeletionToChannel(
  guild: Guild,
  message: MessageLike & {
    content?: string | null;
    edited_content?: string | null;
  },
  verdict: VerdictLike | null | undefined,
  channelId: string,
): Promise<void> {
  if (!config.AUTO_DELETE_LOG_CHANNEL_ID) return;

  try {
    const logChannel = guild.channels.cache.get(
      config.AUTO_DELETE_LOG_CHANNEL_ID,
    );
    if (
      logChannel &&
      "send" in logChannel &&
      typeof (logChannel as ChannelWithSend).send === "function"
    ) {
      const severity = verdict?.severity ?? message.ai_severity ?? "none";
      const status = verdict?.status ?? message.ai_status ?? "unknown";
      const categories =
        (verdict?.categories ?? []).join(", ") ||
        message.ai_categories ||
        message.ai_moderation_flags ||
        "—";
      const reason = verdict?.analysis ?? message.ai_analysis ?? "—";
      const snippet = (
        message.edited_content ??
        message.content ??
        ""
      ).substring(0, 200);
      await (logChannel as ChannelWithSend).send(
        `**🧹 Auto-Delete** — Pesan dari <@${message.user_id}> di <#${channelId}>\n` +
          `**Status:** ${status}\n` +
          `**Severitas:** ${severity}\n` +
          `**Kategori:** ${categories}\n` +
          `**Alasan:** ${reason}\n` +
          `**Isi:** ${snippet}\n` +
          `**Waktu:** <t:${Math.floor(Date.now() / 1000)}:R>`,
      );
      logger.info(
        { channelId, messageId: message.id },
        "Deletion logged to channel",
      );
    }
  } catch (logErr) {
    logger.warn(
      { messageId: message.id, error: String(logErr) },
      "Failed to log auto-delete to moderation channel",
    );
  }
}

/**
 * Report that a flagged message was already gone before we could delete it.
 *
 * Discord answers with MESSAGE_ID_NOT_FOUND when a human moderator, another
 * bot, or the server's own message retention removed the message between our
 * verdict and our delete attempt. We treat that as "deleted" so the verdict is
 * not retried forever, but it is important to say who actually did it: an
 * audit trail where every entry claims the system deleted the message is
 * misleading when most of them were removed by a person.
 */
export async function logAlreadyDeleted(
  guild: Guild,
  message: MessageLike & {
    content?: string | null;
    edited_content?: string | null;
  },
  verdict: VerdictLike | null | undefined,
  channelId: string,
): Promise<void> {
  if (!config.AUTO_DELETE_LOG_CHANNEL_ID) return;

  try {
    const logChannel = guild.channels.cache.get(
      config.AUTO_DELETE_LOG_CHANNEL_ID,
    );
    if (
      logChannel &&
      "send" in logChannel &&
      typeof (logChannel as ChannelWithSend).send === "function"
    ) {
      const severity = verdict?.severity ?? message.ai_severity ?? "none";
      const status = verdict?.status ?? message.ai_status ?? "unknown";
      const categories =
        (verdict?.categories ?? []).join(", ") ||
        message.ai_categories ||
        message.ai_moderation_flags ||
        "—";
      const reason = verdict?.analysis ?? message.ai_analysis ?? "—";
      const snippet = (
        message.edited_content ??
        message.content ??
        ""
      ).substring(0, 200);
      await (logChannel as ChannelWithSend).send(
        `**⏭️ Auto-Delete gagal — sudah dihapus orang lain** — Pesan dari <@${message.user_id}> di <#${channelId}>\n` +
          `**Status:** ${status}\n` +
          `**Severitas:** ${severity}\n` +
          `**Kategori:** ${categories}\n` +
          `**Alasan AI:** ${reason}\n` +
          `**Isi:** ${snippet}\n` +
          `Discord mengembalikan ` +
          `\`MESSAGE_ID_NOT_FOUND\`: pesan sudah tidak ada saat sistem mau ` +
          `menghapus. Kemungkinan dihapus moderator lain, bot lain, atau oleh ` +
          `retensi pesan server. Sistem tidak perlu menghapusnya lagi.\n` +
          `**Waktu:** <t:${Math.floor(Date.now() / 1000)}:R>`,
      );
      logger.info(
        { channelId, messageId: message.id },
        "Already-deleted message logged to channel",
      );
    }
  } catch (logErr) {
    logger.warn(
      { messageId: message.id, error: String(logErr) },
      "Failed to log already-deleted message to moderation channel",
    );
  }
}
