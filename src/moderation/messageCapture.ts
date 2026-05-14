import type { Client, Message } from "discord.js-selfbot-v13";
import { config } from "../config";
import { createChildLogger } from "../logger";
import { queueMessageAnalysis } from "./aiAnalyzer";
import {
  getDisplayContent,
  getMessageLocation,
  getMessageMetadata,
} from "./messageMetadata";
import {
  getMessageById,
  insertAttachment,
  updateMessageAsDeleted,
  updateMessageAsEdited,
  upsertMessageForCapture,
} from "./messageStore";
import type {
  AttachmentRecord,
  MessageRecord,
  ModerationBroadcaster,
} from "./types";

const logger = createChildLogger("message-capture");

type ModerationGlobal = typeof globalThis & {
  moderationBroadcaster?: ModerationBroadcaster;
};

function getModerationBroadcaster(): ModerationBroadcaster | undefined {
  return (globalThis as ModerationGlobal).moderationBroadcaster;
}

export async function captureMessage(
  message: Message,
  type: "text" | "edited" | "deleted",
  options: { source?: "live" | "backlog" } = {},
): Promise<void> {
  const location = getMessageLocation(message);
  const metadata = getMessageMetadata(message);

  const messageRecord: MessageRecord = {
    id: message.id,
    guild_id: message.guildId!,
    channel_id: location.channelId,
    thread_id: location.threadId,
    user_id: message.author?.id,
    username: message.author?.username,
    avatar_url: message.author?.avatarURL() || null,
    content: getDisplayContent(message),
    edited_content: null,
    created_at: message.createdTimestamp,
    edited_at: null,
    deleted_at: null,
    type,
    metadata: JSON.stringify(metadata),
  };

  const inserted = await upsertMessageForCapture(messageRecord);
  if (!inserted) {
    return;
  }

  const isBacklog = options.source === "backlog";
  if (!isBacklog) {
    queueMessageAnalysis(message.id);
  }

  const broadcaster = getModerationBroadcaster();
  if (broadcaster && !isBacklog) {
    broadcaster.messageCreated(messageRecord);
  }

  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      const attachmentRecord: AttachmentRecord = {
        id: attachment.id,
        message_id: message.id,
        guild_id: message.guildId!,
        channel_id: location.channelId,
        thread_id: location.threadId,
        user_id: message.author?.id,
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

      await insertAttachment(attachmentRecord);

      if (broadcaster) {
        broadcaster.attachmentCreated(attachmentRecord);
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

export function registerMessageCapture(client: Client): void {
  client.on("messageCreate", async (message) => {
    if (!message.guildId || message.guildId !== config.MONITOR_GUILD_ID) return;
    if (message.author?.bot) return;

    try {
      await captureMessage(message, "text");
    } catch (error) {
      logger.error(
        {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to capture message",
      );
    }
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    if (!newMessage.guildId || newMessage.guildId !== config.MONITOR_GUILD_ID)
      return;
    if (newMessage.author?.bot) return;

    try {
      const existing = await getMessageById(newMessage.id);

      if (existing) {
        const editedAt = Date.now();
        await updateMessageAsEdited(
          newMessage.id,
          getDisplayContent(newMessage as Message),
          editedAt,
        );
        queueMessageAnalysis(newMessage.id);

        const broadcaster = getModerationBroadcaster();
        if (broadcaster) {
          broadcaster.messageUpdated({
            id: newMessage.id,
            edited_content: getDisplayContent(newMessage as Message),
            edited_at: editedAt,
          });
        }
      } else if (newMessage.author) {
        await captureMessage(newMessage as Message, "text");
      }
    } catch (error) {
      logger.error(
        {
          messageId: newMessage.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to capture message update",
      );
    }
  });

  client.on("messageDelete", async (message) => {
    if (!message.guildId || message.guildId !== config.MONITOR_GUILD_ID) return;
    if (!message.author) return;

    try {
      const deletedAt = Date.now();
      await updateMessageAsDeleted(message.id, deletedAt);

      const broadcaster = getModerationBroadcaster();
      if (broadcaster) {
        broadcaster.messageDeleted({
          id: message.id,
          deleted_at: deletedAt,
        });
      }

      logger.info({ messageId: message.id }, "Message deletion captured");
    } catch (error) {
      logger.error(
        {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to capture message deletion",
      );
    }
  });

  logger.info("Message capture handlers registered");
}
