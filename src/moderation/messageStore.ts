import { getDatabase } from "../database/drizzle";
import { messagesTable, attachmentsTable } from "../database/schema";
import { eq, or, desc, asc, and, isNull } from "drizzle-orm";
import { createChildLogger } from "../logger";
import type { AttachmentRecord, MessageRecord } from "./types";

const logger = createChildLogger("message-store");

export async function insertMessage(
  message: MessageRecord,
): Promise<void> {
  try {
    const db = getDatabase() as any;
    await db.insert(messagesTable).values(message).onConflictDoNothing();

    logger.debug(
      { messageId: message.id, channelId: message.channel_id },
      "Message inserted",
    );
  } catch (error) {
    logger.error(
      {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to insert message",
    );
    throw error;
  }
}

export async function updateMessageAsEdited(
  messageId: string,
  editedContent: string,
  editedAt: number,
): Promise<void> {
  try {
    const db = getDatabase() as any;
    await db
      .update(messagesTable)
      .set({
        edited_content: editedContent,
        edited_at: editedAt,
        type: "edited",
      })
      .where(eq(messagesTable.id, messageId));

    logger.debug({ messageId }, "Message marked as edited");
  } catch (error) {
    logger.error(
      {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update message as edited",
    );
    throw error;
  }
}

export async function updateMessageAsDeleted(
  messageId: string,
  deletedAt: number,
): Promise<void> {
  try {
    const db = getDatabase() as any;
    await db
      .update(messagesTable)
      .set({
        deleted_at: deletedAt,
        type: "deleted",
      })
      .where(eq(messagesTable.id, messageId));

    logger.debug({ messageId }, "Message marked as deleted");
  } catch (error) {
    logger.error(
      {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update message as deleted",
    );
    throw error;
  }
}

export async function getMessagesByChannel(
  channelId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<MessageRecord[]> {
  try {
    const db = getDatabase() as any;
    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        or(
          eq(messagesTable.channel_id, channelId),
          eq(messagesTable.thread_id, channelId),
        ),
      )
      .orderBy(desc(messagesTable.created_at))
      .limit(limit)
      .offset(offset);

    return rows as MessageRecord[];
  } catch (error) {
    logger.error(
      {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get messages by channel",
    );
    throw error;
  }
}

export async function insertAttachment(
  attachment: AttachmentRecord,
): Promise<void> {
  try {
    const db = getDatabase() as any;
    await db.insert(attachmentsTable).values(attachment).onConflictDoNothing();

    logger.debug(
      { attachmentId: attachment.id, messageId: attachment.message_id },
      "Attachment inserted",
    );
  } catch (error) {
    logger.error(
      {
        attachmentId: attachment.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to insert attachment",
    );
    throw error;
  }
}

export async function getAttachmentsByChannel(
  channelId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<AttachmentRecord[]> {
  try {
    const db = getDatabase() as any;
    const rows = await db
      .select()
      .from(attachmentsTable)
      .where(
        or(
          eq(attachmentsTable.channel_id, channelId),
          eq(attachmentsTable.thread_id, channelId),
        ),
      )
      .orderBy(desc(attachmentsTable.created_at))
      .limit(limit)
      .offset(offset);

    return rows as AttachmentRecord[];
  } catch (error) {
    logger.error(
      {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get attachments by channel",
    );
    throw error;
  }
}

export async function updateAttachmentAsUploaded(
  attachmentId: string,
  uploadedUrl: string,
  uploadedAt: number,
): Promise<void> {
  try {
    const db = getDatabase() as any;
    await db
      .update(attachmentsTable)
      .set({
        uploaded_url: uploadedUrl,
        upload_status: "uploaded",
        uploaded_at: uploadedAt,
      })
      .where(eq(attachmentsTable.id, attachmentId));

    logger.debug(
      { attachmentId, uploadedUrl },
      "Attachment marked as uploaded",
    );
  } catch (error) {
    logger.error(
      {
        attachmentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update attachment as uploaded",
    );
    throw error;
  }
}

export async function updateAttachmentAsFailedUpload(
  attachmentId: string,
  error: string,
): Promise<void> {
  try {
    const db = getDatabase() as any;
    await db
      .update(attachmentsTable)
      .set({
        upload_status: "failed",
        upload_error: error,
      })
      .where(eq(attachmentsTable.id, attachmentId));

    logger.debug({ attachmentId, error }, "Attachment marked as failed upload");
  } catch (error) {
    logger.error(
      {
        attachmentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update attachment as failed",
    );
    throw error;
  }
}

interface AIAnalysisUpdate {
  status: "pending" | "clean" | "warn" | "flagged" | "error";
  flags?: string | null;
  score?: number | null;
  raw?: string | null;
  analysis?: string | null;
  analyzedAt?: number | null;
  error?: string | null;
}

export async function updateMessageAIAnalysis(
  messageId: string,
  result: AIAnalysisUpdate,
): Promise<MessageRecord | null> {
  try {
    const db = getDatabase() as any;
    await db
      .update(messagesTable)
      .set({
        ai_status: result.status,
        ai_moderation_flags: result.flags ?? null,
        ai_moderation_score: result.score ?? null,
        ai_moderation_raw: result.raw ?? null,
        ai_analysis: result.analysis ?? null,
        ai_analyzed_at: result.analyzedAt ?? Date.now(),
        ai_error: result.error ?? null,
      })
      .where(eq(messagesTable.id, messageId));

    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId));

    return (rows[0] as MessageRecord) ?? null;
  } catch (error) {
    logger.error(
      {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update message AI analysis",
    );
    throw error;
  }
}

export async function getPendingAIAnalysisMessages(
  limit: number = 25,
): Promise<MessageRecord[]> {
  try {
    const db = getDatabase() as any;
    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.ai_status, "pending"),
          isNull(messagesTable.deleted_at),
        ),
      )
      .orderBy(asc(messagesTable.created_at))
      .limit(limit);

    return rows as MessageRecord[];
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get pending AI analysis messages",
    );
    throw error;
  }
}

export async function getMessageById(
  messageId: string,
): Promise<MessageRecord | null> {
  try {
    const db = getDatabase() as any;
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId));

    return (rows[0] as MessageRecord) ?? null;
  } catch (error) {
    logger.error(
      {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get message by id",
    );
    throw error;
  }
}
