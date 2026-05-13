import type { Client, Message } from "discord.js-selfbot-v13";
import { createChildLogger } from "../logger";
import { config } from "../config";
import type { SqliteDatabase } from "../muxer-queue";
import { insertMessage, insertAttachment } from "./messageStore";
import { getDisplayContent, getMessageLocation, getMessageMetadata } from "./messageMetadata";
import { queueMessageAnalysis } from "./aiAnalyzer";
import type { MessageRecord, AttachmentRecord } from "./types";

const logger = createChildLogger("message-capture");

export async function captureMessage(
  db: SqliteDatabase,
  message: Message,
  type: "text" | "edited" | "deleted",
): Promise<void> {
  const location = getMessageLocation(message);
  const metadata = getMessageMetadata(message);

  const messageRecord: MessageRecord = {
    id: message.id,
    guild_id: message.guildId!,
    channel_id: location.channelId,
    thread_id: location.threadId,
    user_id: message.author!.id,
    username: message.author!.username,
    avatar_url: message.author!.avatarURL() || null,
    content: getDisplayContent(message),
    edited_content: null,
    created_at: message.createdTimestamp,
    edited_at: null,
    deleted_at: null,
    type,
    metadata: JSON.stringify(metadata),
  };

  insertMessage(db, messageRecord);
  queueMessageAnalysis(db, message.id);

  const broadcaster = globalThis as any;
  if (broadcaster.broadcastMessageCreated) {
    broadcaster.broadcastMessageCreated({
      ...messageRecord,
      type: "text",
    });
  }

  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      const attachmentRecord: AttachmentRecord = {
        id: attachment.id,
        message_id: message.id,
        guild_id: message.guildId!,
        channel_id: location.channelId,
        thread_id: location.threadId,
        user_id: message.author!.id,
        filename: attachment.name || "unknown",
        size: attachment.size,
        type: attachment.contentType || "application/octet-stream",
        discord_url: attachment.url,
        uploaded_url: attachment.url,
        upload_status: "uploaded",
        upload_error: null,
        created_at: Date.now(),
        uploaded_at: Date.now(),
      };

      insertAttachment(db, attachmentRecord);

      if (broadcaster.broadcastAttachmentUploaded) {
        broadcaster.broadcastAttachmentUploaded({
          id: attachment.id,
          message_id: message.id,
          filename: attachment.name || "unknown",
          channel_id: location.channelId,
          created_at: Date.now(),
        });
      }
    }
  }

  logger.info(
    {
      messageId: message.id,
      channelId: message.channelId,
      attachmentCount: message.attachments.size,
    },
    "Message captured",
  );
}

export function registerMessageCapture(client: Client, db: SqliteDatabase): void {
  client.on("messageCreate", async (message) => {
    if (!message.guildId || message.guildId !== config.MONITOR_GUILD_ID) return;
    if (message.author?.bot) return;

    try {
      await captureMessage(db, message, "text");
    } catch (error) {
      logger.error(
        { messageId: message.id, error: error instanceof Error ? error.message : String(error) },
        "Failed to capture message",
      );
    }
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    if (!newMessage.guildId || newMessage.guildId !== config.MONITOR_GUILD_ID) return;
    if (newMessage.author?.bot) return;

    try {
      const { updateMessageAsEdited } = await import("./messageStore");

      const existing = db
        .prepare("SELECT id FROM messages WHERE id = ?")
        .get(newMessage.id) as { id: string } | undefined;

      if (existing) {
        const editedAt = Date.now();
        updateMessageAsEdited(db, newMessage.id, getDisplayContent(newMessage as Message), editedAt);
        queueMessageAnalysis(db, newMessage.id);

        const broadcaster = globalThis as any;
        if (broadcaster.broadcastMessageUpdated) {
          broadcaster.broadcastMessageUpdated({
            id: newMessage.id,
            edited_content: getDisplayContent(newMessage as Message),
            edited_at: editedAt,
          });
        }
      } else if (newMessage.author) {
        await captureMessage(db, newMessage as Message, "text");
      }
    } catch (error) {
      logger.error(
        { messageId: newMessage.id, error: error instanceof Error ? error.message : String(error) },
        "Failed to capture message update",
      );
    }
  });

  client.on("messageDelete", async (message) => {
    if (!message.guildId || message.guildId !== config.MONITOR_GUILD_ID) return;
    if (!message.author) return;

    try {
      const { updateMessageAsDeleted } = await import("./messageStore");
      const deletedAt = Date.now();
      updateMessageAsDeleted(db, message.id, deletedAt);

      const broadcaster = globalThis as any;
      if (broadcaster.broadcastMessageDeleted) {
        broadcaster.broadcastMessageDeleted({
          id: message.id,
          deleted_at: deletedAt,
        });
      }

      logger.info({ messageId: message.id }, "Message deletion captured");
    } catch (error) {
      logger.error(
        { messageId: message.id, error: error instanceof Error ? error.message : String(error) },
        "Failed to capture message deletion",
      );
    }
  });

  logger.info("Message capture handlers registered");
}
