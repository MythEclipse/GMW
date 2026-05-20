import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDatabase } from "../database/drizzle.ts";
import { attachmentsTable, messagesTable } from "../database/schema.ts";
import { createChildLogger } from "../logger.ts";
import { decodeCursor, encodeCursor } from "./pagination";
import type {
  AttachmentRecord,
  MessageQuery,
  MessageRecord,
  PageResult,
} from "./types";

const logger = createChildLogger("message-store");

interface QueryBuilder<T = unknown> extends PromiseLike<T> {
  from(...args: unknown[]): QueryBuilder<T>;
  where(...args: unknown[]): QueryBuilder<T>;
  orderBy(...args: unknown[]): QueryBuilder<T>;
  limit(...args: unknown[]): QueryBuilder<T>;
  offset(...args: unknown[]): QueryBuilder<T>;
  values(...args: unknown[]): QueryBuilder<T>;
  onConflictDoNothing(...args: unknown[]): QueryBuilder<T>;
  returning(...args: unknown[]): QueryBuilder<T>;
  set(...args: unknown[]): QueryBuilder<T>;
}

interface MessageDatabase {
  select<T = unknown[]>(...args: unknown[]): QueryBuilder<T>;
  selectDistinct<T = unknown[]>(...args: unknown[]): QueryBuilder<T>;
  insert<T = unknown>(...args: unknown[]): QueryBuilder<T>;
  update(...args: unknown[]): QueryBuilder<unknown>;
}

function db(): MessageDatabase {
  return getDatabase() as unknown as MessageDatabase;
}

export { decodeCursor, encodeCursor } from "./pagination";

export async function insertMessage(message: MessageRecord): Promise<void> {
  try {
    const database = db();
    await database.insert(messagesTable).values(message).onConflictDoNothing();
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
): Promise<boolean> {
  try {
    const database = db();
    const messageWithAIStatus = {
      ...message,
      ai_status: "pending" as const,
    };

    const rows = await database
      .insert<Array<{ id: string }>>(messagesTable)
      .values(messageWithAIStatus)
      .onConflictDoNothing()
      .returning({ id: messagesTable.id });

    return rows.length > 0;
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
    const database = db();
    await database
      .update(messagesTable)
      .set({
        edited_content: editedContent,
        edited_at: editedAt,
        type: "edited",
        ai_status: "pending",
        ai_moderation_flags: null,
        ai_moderation_score: null,
        ai_moderation_raw: null,
        ai_analysis: null,
        ai_analyzed_at: null,
        ai_error: null,
      })
      .where(eq(messagesTable.id, messageId));
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
    const database = db();
    await database
      .update(messagesTable)
      .set({
        deleted_at: deletedAt,
        type: "deleted",
      })
      .where(eq(messagesTable.id, messageId));
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
    const database = db();
    const rows = await database
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
    const database = db();
    await database
      .insert(attachmentsTable)
      .values(attachment)
      .onConflictDoNothing();
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
    const database = db();
    const rows = await database
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
    const database = db();
    await database
      .update(attachmentsTable)
      .set({
        uploaded_url: uploadedUrl,
        upload_status: "uploaded",
        uploaded_at: uploadedAt,
      })
      .where(eq(attachmentsTable.id, attachmentId));
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
    const database = db();
    await database
      .update(attachmentsTable)
      .set({
        upload_status: "failed",
        upload_error: error,
      })
      .where(eq(attachmentsTable.id, attachmentId));
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
    const database = db();
    await database
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

    const rows = await database
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
    const database = db();
    const rows = await database
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
    const database = db();
    const rows = await database
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
    const database = db();
    const conditions: SQL[] = [];

    // Apply filters
    if (query.guildId) {
      conditions.push(eq(messagesTable.guild_id, query.guildId));
    }

    if (query.channelId) {
      conditions.push(
        sql`(${messagesTable.channel_id} = ${query.channelId} or ${messagesTable.thread_id} = ${query.channelId})`,
      );
    }

    if (query.threadId) {
      conditions.push(eq(messagesTable.thread_id, query.threadId));
    }

    if (query.userId) {
      conditions.push(eq(messagesTable.user_id, query.userId));
    }

    if (query.status && query.status.length > 0) {
      conditions.push(sql`${messagesTable.ai_status} in ${query.status}`);
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
          sql`(${messagesTable.created_at} < ${cursorData.created_at} or (${messagesTable.created_at} = ${cursorData.created_at} and ${messagesTable.id} < ${cursorData.id}))`,
        );
      }
    }

    // Fetch limit + 1 to determine if there's a next page
    const fetchLimit = query.limit + 1;
    const rows = await database
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
    const database = db();
    const { channelId, threadId, beforeCreatedAt, limit } = input;

    // Query same thread if threadId exists, otherwise channelId
    const locationCondition = threadId
      ? eq(messagesTable.thread_id, threadId)
      : eq(messagesTable.channel_id, channelId);

    const rows = await database
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
    const database = db();

    // conversationKey is either thread_id or channel_id
    // Query both to safely handle the key
    const rows = await database
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
    const database = db();

    // Get distinct conversation keys (thread_id or channel_id) for pending messages
    const rows = await database
      .selectDistinct<Array<{ thread_id: string | null; channel_id: string }>>({
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
    for (const row of rows) {
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

export async function getAttachmentsForMessages(
  messageIds: string[],
): Promise<AttachmentRecord[]> {
  try {
    if (messageIds.length === 0) return [];
    const database = db();
    const rows = await database
      .select()
      .from(attachmentsTable)
      .where(inArray(attachmentsTable.message_id, messageIds));

    return rows as AttachmentRecord[];
  } catch (error) {
    logger.error(
      {
        messageIds,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get attachments for messages",
    );
    throw error;
  }
}

export async function searchMessages(input: {
  query: string;
  channelId?: string;
  limit?: number;
}): Promise<MessageRecord[]> {
  try {
    const { query, channelId, limit = 20 } = input;
    const database = db();

    const searchPattern = `%${query}%`;
    const conditions: (SQL | undefined)[] = [isNull(messagesTable.deleted_at)];

    if (channelId) {
      conditions.push(
        or(
          eq(messagesTable.channel_id, channelId),
          eq(messagesTable.thread_id, channelId),
        ),
      );
    }

    conditions.push(
      or(
        sql`${messagesTable.content} LIKE ${searchPattern}`,
        sql`${messagesTable.edited_content} LIKE ${searchPattern}`,
      ),
    );

    const validConditions = conditions.filter((c): c is SQL => c !== undefined);

    const rows = await database
      .select()
      .from(messagesTable)
      .where(and(...validConditions))
      .orderBy(desc(messagesTable.created_at))
      .limit(limit);

    return rows as MessageRecord[];
  } catch (error) {
    logger.error(
      {
        query: input.query,
        channelId: input.channelId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to search messages",
    );
    throw error;
  }
}
