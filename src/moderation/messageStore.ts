import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDatabase } from "../database/drizzle";
import { attachmentsTable, messagesTable } from "../database/schema";
import { createChildLogger } from "../logger";
import type {
  AttachmentRecord,
  MessageQuery,
  MessageRecord,
  PageResult,
} from "./types";

const logger = createChildLogger("message-store");

// Cursor helpers for pagination
interface CursorData {
  created_at: number;
  id: string;
}

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

export function decodeCursor(cursor?: string): CursorData | null {
  if (!cursor) return null;
  try {
    const data = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
    if (typeof data.created_at === "number" && typeof data.id === "string") {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export async function insertMessage(message: MessageRecord): Promise<void> {
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

export async function upsertMessageForCapture(
  message: MessageRecord,
): Promise<void> {
  try {
    const db = getDatabase() as any;

    // Set ai_status to pending for new or recaptured/edited text
    const messageWithAIStatus = {
      ...message,
      ai_status: "pending" as const,
    };

    // Try insert first (fast path for new messages)
    await db
      .insert(messagesTable)
      .values(messageWithAIStatus)
      .onConflictDoNothing();

    logger.debug(
      { messageId: message.id, channelId: message.channel_id },
      "Message upserted for capture",
    );
  } catch (error) {
    logger.error(
      {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to upsert message for capture",
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

export async function listMessages(
  query: MessageQuery,
): Promise<PageResult<MessageRecord>> {
  try {
    const db = getDatabase() as any;
    const conditions: any[] = [];

    // Apply filters
    if (query.guildId) {
      conditions.push(eq(messagesTable.guild_id, query.guildId));
    }

    if (query.channelId) {
      conditions.push(
        or(
          eq(messagesTable.channel_id, query.channelId),
          eq(messagesTable.thread_id, query.channelId),
        ),
      );
    }

    if (query.threadId) {
      conditions.push(eq(messagesTable.thread_id, query.threadId));
    }

    if (query.userId) {
      conditions.push(eq(messagesTable.user_id, query.userId));
    }

    if (query.status && query.status.length > 0) {
      conditions.push(
        or(
          ...query.status.map((status) => eq(messagesTable.ai_status, status)),
        ),
      );
    }

    // Text search
    if (query.q) {
      const pattern = `%${query.q.toLowerCase()}%`;
      conditions.push(sql`lower(${messagesTable.content}) like ${pattern}`);
    }

    // Cursor-based pagination (newest first)
    if (query.cursor) {
      const cursorData = decodeCursor(query.cursor);
      if (cursorData) {
        conditions.push(
          or(
            sql`${messagesTable.created_at} < ${cursorData.created_at}`,
            and(
              eq(messagesTable.created_at, cursorData.created_at),
              sql`${messagesTable.id} < ${cursorData.id}`,
            ),
          ),
        );
      }
    }

    // Fetch limit + 1 to determine if there's a next page
    const fetchLimit = query.limit + 1;
    const rows = await db
      .select()
      .from(messagesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(messagesTable.created_at), desc(messagesTable.id))
      .limit(fetchLimit);

    const hasMore = rows.length > query.limit;
    const data = rows.slice(0, query.limit) as MessageRecord[];

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = encodeCursor({
        created_at: lastItem.created_at,
        id: lastItem.id,
      });
    }

    return { data, nextCursor };
  } catch (error) {
    logger.error(
      {
        query,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to list messages",
    );
    throw error;
  }
}

export async function listReviewMessages(
  query: Omit<MessageQuery, "status">,
): Promise<PageResult<MessageRecord>> {
  return listMessages({
    ...query,
    status: ["warn", "flagged", "error"],
  });
}

export async function getConversationContextBefore(input: {
  channelId: string;
  threadId: string | null;
  beforeCreatedAt: number;
  limit: number;
}): Promise<MessageRecord[]> {
  try {
    const db = getDatabase() as any;
    const { channelId, threadId, beforeCreatedAt, limit } = input;

    // Query same thread if threadId exists, otherwise channelId
    const locationCondition = threadId
      ? eq(messagesTable.thread_id, threadId)
      : eq(messagesTable.channel_id, channelId);

    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          locationCondition,
          sql`${messagesTable.created_at} < ${beforeCreatedAt}`,
          isNull(messagesTable.deleted_at),
        ),
      )
      .orderBy(desc(messagesTable.created_at))
      .limit(limit);

    // Return in chronological order (oldest first)
    return (rows as MessageRecord[]).reverse();
  } catch (error) {
    logger.error(
      {
        channelId: input.channelId,
        threadId: input.threadId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get conversation context before",
    );
    throw error;
  }
}

export async function getPendingMessagesByConversation(
  conversationKey: string,
  limit: number = 25,
): Promise<MessageRecord[]> {
  try {
    const db = getDatabase() as any;

    // conversationKey is either thread_id or channel_id
    // Query both to safely handle the key
    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          or(
            eq(messagesTable.thread_id, conversationKey),
            eq(messagesTable.channel_id, conversationKey),
          ),
          eq(messagesTable.ai_status, "pending"),
          isNull(messagesTable.deleted_at),
        ),
      )
      .orderBy(asc(messagesTable.created_at))
      .limit(limit);

    return rows as MessageRecord[];
  } catch (error) {
    logger.error(
      {
        conversationKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get pending messages by conversation",
    );
    throw error;
  }
}

export async function getPendingConversationKeys(
  limit: number = 100,
): Promise<string[]> {
  try {
    const db = getDatabase() as any;

    // Get distinct conversation keys (thread_id or channel_id) for pending messages
    const rows = await db
      .selectDistinct({
        thread_id: messagesTable.thread_id,
        channel_id: messagesTable.channel_id,
      })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.ai_status, "pending"),
          isNull(messagesTable.deleted_at),
        ),
      )
      .limit(limit);

    const keys: string[] = [];
    for (const row of rows as any[]) {
      const key = row.thread_id || row.channel_id;
      if (key && !keys.includes(key)) {
        keys.push(key);
      }
    }

    return keys;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get pending conversation keys",
    );
    throw error;
  }
}
