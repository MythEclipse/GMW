/**
 * DM notification for auto-deleted messages.
 *
 * Ported from the pre-rewrite `autoDeleteNotify.ts`, with the reason read from
 * the verdict row rather than the legacy `ai_analysis` column.
 */
import type { Client } from "discord.js-selfbot-v13";
import { config } from "../../shared/config/index.js";
import { createChildLogger } from "../../shared/logger/index.js";
import type { MessageLike, VerdictLike } from "./autoDeleteEligibility.js";

const logger = createChildLogger("auto-delete-notify");

/**
 * DM the user whose message was deleted. DM failures are swallowed at debug
 * level — a closed DM box must not fail the deletion that already succeeded.
 */
export async function sendDeletionNotification(
  client: Client,
  message: MessageLike,
  verdict: VerdictLike | null | undefined,
  guildName: string,
): Promise<void> {
  try {
    const targetUser = await client.users.fetch(message.user_id);
    if (targetUser) {
      // Prefer the descriptive analysis so the user understands WHY; fall back
      // to category/flag labels when it is unavailable.
      const analysis = (verdict?.analysis ?? message.ai_analysis ?? "").trim();
      const reason: string =
        (analysis.length > 240 ? `${analysis.slice(0, 240)}…` : analysis) ||
        (verdict?.categories ?? []).join(", ") ||
        message.ai_categories ||
        message.ai_moderation_flags ||
        "(unknown)";
      await targetUser.send(
        `Pesan Anda di **${guildName}** telah dihapus oleh sistem moderasi otomatis.\n` +
          `Alasan: ${reason}\n` +
          `Jika Anda merasa ini adalah kesalahan, silakan hubungi admin server.`,
      );
      logger.info(
        { userId: message.user_id, messageId: message.id },
        "Deletion notification sent",
      );
    }
  } catch (dmErr) {
    logger.debug(
      {
        messageId: message.id,
        userId: message.user_id,
        error: String(dmErr),
      },
      "Failed to send DM notification for auto-deleted message",
    );
  }
}
