import { createChildLogger } from "../logger";
import type { SqliteDatabase } from "../muxer-queue";
import type { MessageRecord, AttachmentRecord } from "./types";

const logger = createChildLogger("message-store");

export function insertMessage(db: SqliteDatabase, message: MessageRecord): void {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, guild_id, channel_id, thread_id, user_id, username, avatar_url,
        content, edited_content, created_at, edited_at, deleted_at, type, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      message.guild_id,
      message.channel_id,
      message.thread_id,
      message.user_id,
      message.username,
      message.avatar_url,
      message.content,
      message.edited_content,
      message.created_at,
      message.edited_at,
      message.deleted_at,
      message.type,
      message.metadata,
    );

    logger.debug({ messageId: message.id, channelId: message.channel_id }, "Message inserted");
  } catch (error) {
    logger.error(
      { messageId: message.id, error: error instanceof Error ? error.message : String(error) },
      "Failed to insert message",
    );
    throw error;
  }
}

export function updateMessageAsEdited(
  db: SqliteDatabase,
  messageId: string,
  editedContent: string,
  editedAt: number,
): void {
  try {
    const stmt = db.prepare(`
      UPDATE messages
      SET edited_content = ?, edited_at = ?, type = 'edited'
      WHERE id = ?
    `);

    stmt.run(editedContent, editedAt, messageId);
    logger.debug({ messageId }, "Message marked as edited");
  } catch (error) {
    logger.error(
      { messageId, error: error instanceof Error ? error.message : String(error) },
      "Failed to update message as edited",
    );
    throw error;
  }
}

export function updateMessageAsDeleted(
  db: SqliteDatabase,
  messageId: string,
  deletedAt: number,
): void {
  try {
    const stmt = db.prepare(`
      UPDATE messages
      SET deleted_at = ?, type = 'deleted'
      WHERE id = ?
    `);

    stmt.run(deletedAt, messageId);
    logger.debug({ messageId }, "Message marked as deleted");
  } catch (error) {
    logger.error(
      { messageId, error: error instanceof Error ? error.message : String(error) },
      "Failed to update message as deleted",
    );
    throw error;
  }
}

export function getMessagesByChannel(
  db: SqliteDatabase,
  channelId: string,
  limit: number = 50,
  offset: number = 0,
): MessageRecord[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM messages
      WHERE channel_id = ? OR thread_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(channelId, channelId, limit, offset) as MessageRecord[];
    return rows;
  } catch (error) {
    logger.error(
      { channelId, error: error instanceof Error ? error.message : String(error) },
      "Failed to get messages by channel",
    );
    throw error;
  }
}

export function insertAttachment(db: SqliteDatabase, attachment: AttachmentRecord): void {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO attachments (
        id, message_id, guild_id, channel_id, thread_id, user_id, filename, size, type,
        discord_url, uploaded_url, upload_status, upload_error, created_at, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      attachment.id,
      attachment.message_id,
      attachment.guild_id,
      attachment.channel_id,
      attachment.thread_id,
      attachment.user_id,
      attachment.filename,
      attachment.size,
      attachment.type,
      attachment.discord_url,
      attachment.uploaded_url,
      attachment.upload_status,
      attachment.upload_error,
      attachment.created_at,
      attachment.uploaded_at,
    );

    logger.debug({ attachmentId: attachment.id, messageId: attachment.message_id }, "Attachment inserted");
  } catch (error) {
    logger.error(
      { attachmentId: attachment.id, error: error instanceof Error ? error.message : String(error) },
      "Failed to insert attachment",
    );
    throw error;
  }
}

export function getAttachmentsByChannel(
  db: SqliteDatabase,
  channelId: string,
  limit: number = 50,
  offset: number = 0,
): AttachmentRecord[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM attachments
      WHERE channel_id = ? OR thread_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(channelId, channelId, limit, offset) as AttachmentRecord[];
    return rows;
  } catch (error) {
    logger.error(
      { channelId, error: error instanceof Error ? error.message : String(error) },
      "Failed to get attachments by channel",
    );
    throw error;
  }
}

export function updateAttachmentAsUploaded(
  db: SqliteDatabase,
  attachmentId: string,
  uploadedUrl: string,
  uploadedAt: number,
): void {
  try {
    const stmt = db.prepare(`
      UPDATE attachments
      SET uploaded_url = ?, upload_status = 'uploaded', uploaded_at = ?
      WHERE id = ?
    `);

    stmt.run(uploadedUrl, uploadedAt, attachmentId);
    logger.debug({ attachmentId, uploadedUrl }, "Attachment marked as uploaded");
  } catch (error) {
    logger.error(
      { attachmentId, error: error instanceof Error ? error.message : String(error) },
      "Failed to update attachment as uploaded",
    );
    throw error;
  }
}

export function updateAttachmentAsFailedUpload(
  db: SqliteDatabase,
  attachmentId: string,
  error: string,
): void {
  try {
    const stmt = db.prepare(`
      UPDATE attachments
      SET upload_status = 'failed', upload_error = ?
      WHERE id = ?
    `);

    stmt.run(error, attachmentId);
    logger.debug({ attachmentId, error }, "Attachment marked as failed upload");
  } catch (error) {
    logger.error(
      { attachmentId, error: error instanceof Error ? error.message : String(error) },
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

export function updateMessageAIAnalysis(
  db: SqliteDatabase,
  messageId: string,
  result: AIAnalysisUpdate,
): MessageRecord | null {
  try {
    const stmt = db.prepare(`
      UPDATE messages
      SET ai_status = ?, ai_moderation_flags = ?, ai_moderation_score = ?,
          ai_moderation_raw = ?, ai_analysis = ?, ai_analyzed_at = ?, ai_error = ?
      WHERE id = ?
    `);

    stmt.run(
      result.status,
      result.flags ?? null,
      result.score ?? null,
      result.raw ?? null,
      result.analysis ?? null,
      result.analyzedAt ?? Date.now(),
      result.error ?? null,
      messageId,
    );

    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRecord | undefined;
    return row ?? null;
  } catch (error) {
    logger.error(
      { messageId, error: error instanceof Error ? error.message : String(error) },
      "Failed to update message AI analysis",
    );
    throw error;
  }
}

export function getPendingAIAnalysisMessages(
  db: SqliteDatabase,
  limit: number = 25,
): MessageRecord[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM messages
      WHERE ai_status = 'pending'
        AND deleted_at IS NULL
        AND COALESCE(edited_content, content) != ''
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all(limit) as MessageRecord[];
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to get pending AI analysis messages",
    );
    throw error;
  }
}

export function getMessageById(db: SqliteDatabase, messageId: string): MessageRecord | null {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRecord | undefined;
  return row ?? null;
}
