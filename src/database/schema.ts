import {
  bigint as pgBigint,
  foreignKey as pgForeignKey,
  index as pgIndex,
  integer as pgInteger,
  real as pgReal,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import {
  index as sqliteIndex,
  integer as sqliteInteger,
  real as sqliteReal,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import { config } from "../config";

// PostgreSQL Schema
// ==================

/**
 * Muxer Jobs Table (PostgreSQL)
 * Tracks audio post-processing jobs with status and retry logic
 */
export const pgMuxerJobsTable = pgTable(
  "muxer_jobs",
  {
    id: pgText("id").primaryKey(),
    data: pgText("data").notNull(),
    status: pgText("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: pgInteger("attempts").notNull().default(0),
    maxAttempts: pgInteger("maxAttempts").notNull().default(3),
    createdAt: pgBigint("createdAt", { mode: "number" }).notNull(),
    updatedAt: pgBigint("updatedAt", { mode: "number" }).notNull(),
    error: pgText("error"),
  },
  (table) => ({
    statusIdx: pgIndex("idx_muxer_jobs_status").on(table.status),
    createdAtIdx: pgIndex("idx_muxer_jobs_createdAt").on(table.createdAt),
  }),
);

/**
 * Messages Table (PostgreSQL)
 * Stores text messages with AI moderation analysis
 */
export const pgMessagesTable = pgTable(
  "messages",
  {
    id: pgText("id").primaryKey(),
    guild_id: pgText("guild_id").notNull(),
    channel_id: pgText("channel_id").notNull(),
    thread_id: pgText("thread_id"),
    user_id: pgText("user_id").notNull(),
    username: pgText("username").notNull(),
    avatar_url: pgText("avatar_url"),
    content: pgText("content").notNull(),
    edited_content: pgText("edited_content"),
    created_at: pgBigint("created_at", { mode: "number" }).notNull(),
    edited_at: pgBigint("edited_at", { mode: "number" }),
    deleted_at: pgBigint("deleted_at", { mode: "number" }),
    type: pgText("type", { enum: ["text", "edited", "deleted"] })
      .notNull()
      .default("text"),
    metadata: pgText("metadata"),
    ai_status: pgText("ai_status", {
      enum: ["pending", "clean", "warn", "flagged", "error"],
    })
      .notNull()
      .default("pending"),
    ai_moderation_flags: pgText("ai_moderation_flags"),
    ai_moderation_score: pgReal("ai_moderation_score"),
    ai_moderation_raw: pgText("ai_moderation_raw"),
    ai_analysis: pgText("ai_analysis"),
    ai_analyzed_at: pgBigint("ai_analyzed_at", { mode: "number" }),
    ai_error: pgText("ai_error"),
  },
  (table) => ({
    channelIdx: pgIndex("idx_messages_channel").on(table.channel_id),
    userIdx: pgIndex("idx_messages_user").on(table.user_id),
    createdIdx: pgIndex("idx_messages_created").on(table.created_at),
    threadIdx: pgIndex("idx_messages_thread").on(table.thread_id),
    channelCreatedIdx: pgIndex("idx_messages_channel_created").on(
      table.channel_id,
      table.created_at,
      table.id,
    ),
    threadCreatedIdx: pgIndex("idx_messages_thread_created").on(
      table.thread_id,
      table.created_at,
      table.id,
    ),
    aiStatusCreatedIdx: pgIndex("idx_messages_ai_status_created").on(
      table.ai_status,
      table.created_at,
      table.id,
    ),
    guildAiStatusCreatedIdx: pgIndex("idx_messages_guild_ai_status_created").on(
      table.guild_id,
      table.ai_status,
      table.created_at,
      table.id,
    ),
  }),
);

/**
 * Attachments Table (PostgreSQL)
 * Stores attachment metadata with upload status tracking
 */
export const pgAttachmentsTable = pgTable(
  "attachments",
  {
    id: pgText("id").primaryKey(),
    message_id: pgText("message_id").notNull(),
    guild_id: pgText("guild_id").notNull(),
    channel_id: pgText("channel_id").notNull(),
    thread_id: pgText("thread_id"),
    user_id: pgText("user_id").notNull(),
    filename: pgText("filename").notNull(),
    size: pgInteger("size").notNull(),
    type: pgText("type").notNull(),
    discord_url: pgText("discord_url").notNull(),
    uploaded_url: pgText("uploaded_url"),
    upload_status: pgText("upload_status", {
      enum: ["pending", "uploaded", "failed"],
    })
      .notNull()
      .default("pending"),
    upload_error: pgText("upload_error"),
    created_at: pgBigint("created_at", { mode: "number" }).notNull(),
    uploaded_at: pgBigint("uploaded_at", { mode: "number" }),
  },
  (table) => ({
    channelIdx: pgIndex("idx_attachments_channel").on(table.channel_id),
    messageIdx: pgIndex("idx_attachments_message").on(table.message_id),
    statusIdx: pgIndex("idx_attachments_status").on(table.upload_status),
    channelCreatedIdx: pgIndex("idx_attachments_channel_created").on(
      table.channel_id,
      table.created_at,
      table.id,
    ),
    threadCreatedIdx: pgIndex("idx_attachments_thread_created").on(
      table.thread_id,
      table.created_at,
      table.id,
    ),
    messageFk: pgForeignKey({
      columns: [table.message_id],
      foreignColumns: [pgMessagesTable.id],
      name: "fk_attachments_message_id",
    }).onDelete("cascade"),
  }),
);

/**
 * UI State Table (PostgreSQL)
 * Stores persistent UI state (e.g., selected channel, filter preferences)
 */
export const pgUIStateTable = pgTable("ui_state", {
  key: pgText("key").primaryKey(),
  value: pgText("value").notNull(),
  updated_at: pgBigint("updated_at", { mode: "number" }).notNull(),
});

/**
 * AI Analysis Runs Table (PostgreSQL)
 * Tracks AI analysis batch runs for conversation-level moderation
 */
export const pgAIAnalysisRunsTable = pgTable(
  "ai_analysis_runs",
  {
    id: pgText("id").primaryKey(),
    conversation_key: pgText("conversation_key").notNull(),
    target_message_ids: pgText("target_message_ids").notNull(), // JSON array
    model: pgText("model").notNull(),
    request_tokens_estimate: pgInteger("request_tokens_estimate"),
    response_raw: pgText("response_raw"),
    status: pgText("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    error: pgText("error"),
    created_at: pgBigint("created_at", { mode: "number" }).notNull(),
    completed_at: pgBigint("completed_at", { mode: "number" }),
  },
  (table) => ({
    conversationKeyIdx: pgIndex("idx_ai_analysis_runs_conversation_key").on(
      table.conversation_key,
    ),
    statusIdx: pgIndex("idx_ai_analysis_runs_status").on(table.status),
    createdAtIdx: pgIndex("idx_ai_analysis_runs_created_at").on(
      table.created_at,
    ),
  }),
);

// SQLite Schema
// =============

/**
 * Muxer Jobs Table (SQLite)
 * Tracks audio post-processing jobs with status and retry logic
 */
export const sqliteMuxerJobsTable = sqliteTable(
  "muxer_jobs",
  {
    id: sqliteText("id").primaryKey(),
    data: sqliteText("data").notNull(),
    status: sqliteText("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: sqliteInteger("attempts").notNull().default(0),
    maxAttempts: sqliteInteger("maxAttempts").notNull().default(3),
    createdAt: sqliteInteger("createdAt").notNull(),
    updatedAt: sqliteInteger("updatedAt").notNull(),
    error: sqliteText("error"),
  },
  (table) => ({
    statusIdx: sqliteIndex("idx_muxer_jobs_status").on(table.status),
    createdAtIdx: sqliteIndex("idx_muxer_jobs_createdAt").on(table.createdAt),
  }),
);

/**
 * Messages Table (SQLite)
 * Stores text messages with AI moderation analysis
 */
export const sqliteMessagesTable = sqliteTable(
  "messages",
  {
    id: sqliteText("id").primaryKey(),
    guild_id: sqliteText("guild_id").notNull(),
    channel_id: sqliteText("channel_id").notNull(),
    thread_id: sqliteText("thread_id"),
    user_id: sqliteText("user_id").notNull(),
    username: sqliteText("username").notNull(),
    avatar_url: sqliteText("avatar_url"),
    content: sqliteText("content").notNull(),
    edited_content: sqliteText("edited_content"),
    created_at: sqliteInteger("created_at").notNull(),
    edited_at: sqliteInteger("edited_at"),
    deleted_at: sqliteInteger("deleted_at"),
    type: sqliteText("type", { enum: ["text", "edited", "deleted"] })
      .notNull()
      .default("text"),
    metadata: sqliteText("metadata"),
    ai_status: sqliteText("ai_status", {
      enum: ["pending", "clean", "warn", "flagged", "error"],
    })
      .notNull()
      .default("pending"),
    ai_moderation_flags: sqliteText("ai_moderation_flags"),
    ai_moderation_score: sqliteReal("ai_moderation_score"),
    ai_moderation_raw: sqliteText("ai_moderation_raw"),
    ai_analysis: sqliteText("ai_analysis"),
    ai_analyzed_at: sqliteInteger("ai_analyzed_at"),
    ai_error: sqliteText("ai_error"),
  },
  (table) => ({
    channelIdx: sqliteIndex("idx_messages_channel").on(table.channel_id),
    userIdx: sqliteIndex("idx_messages_user").on(table.user_id),
    createdIdx: sqliteIndex("idx_messages_created").on(table.created_at),
    threadIdx: sqliteIndex("idx_messages_thread").on(table.thread_id),
    channelCreatedIdx: sqliteIndex("idx_messages_channel_created").on(
      table.channel_id,
      table.created_at,
      table.id,
    ),
    threadCreatedIdx: sqliteIndex("idx_messages_thread_created").on(
      table.thread_id,
      table.created_at,
      table.id,
    ),
    aiStatusCreatedIdx: sqliteIndex("idx_messages_ai_status_created").on(
      table.ai_status,
      table.created_at,
      table.id,
    ),
    guildAiStatusCreatedIdx: sqliteIndex(
      "idx_messages_guild_ai_status_created",
    ).on(table.guild_id, table.ai_status, table.created_at, table.id),
  }),
);

/**
 * Attachments Table (SQLite)
 * Stores attachment metadata with upload status tracking
 */
export const sqliteAttachmentsTable = sqliteTable(
  "attachments",
  {
    id: sqliteText("id").primaryKey(),
    message_id: sqliteText("message_id").notNull(),
    guild_id: sqliteText("guild_id").notNull(),
    channel_id: sqliteText("channel_id").notNull(),
    thread_id: sqliteText("thread_id"),
    user_id: sqliteText("user_id").notNull(),
    filename: sqliteText("filename").notNull(),
    size: sqliteInteger("size").notNull(),
    type: sqliteText("type").notNull(),
    discord_url: sqliteText("discord_url").notNull(),
    uploaded_url: sqliteText("uploaded_url"),
    upload_status: sqliteText("upload_status", {
      enum: ["pending", "uploaded", "failed"],
    })
      .notNull()
      .default("pending"),
    upload_error: sqliteText("upload_error"),
    created_at: sqliteInteger("created_at").notNull(),
    uploaded_at: sqliteInteger("uploaded_at"),
  },
  (table) => ({
    channelIdx: sqliteIndex("idx_attachments_channel").on(table.channel_id),
    messageIdx: sqliteIndex("idx_attachments_message").on(table.message_id),
    statusIdx: sqliteIndex("idx_attachments_status").on(table.upload_status),
    channelCreatedIdx: sqliteIndex("idx_attachments_channel_created").on(
      table.channel_id,
      table.created_at,
      table.id,
    ),
    threadCreatedIdx: sqliteIndex("idx_attachments_thread_created").on(
      table.thread_id,
      table.created_at,
      table.id,
    ),
  }),
);

/**
 * UI State Table (SQLite)
 * Stores persistent UI state (e.g., selected channel, filter preferences)
 */
export const sqliteUIStateTable = sqliteTable("ui_state", {
  key: sqliteText("key").primaryKey(),
  value: sqliteText("value").notNull(),
  updated_at: sqliteInteger("updated_at").notNull(),
});

/**
 * AI Analysis Runs Table (SQLite)
 * Tracks AI analysis batch runs for conversation-level moderation
 */
export const sqliteAIAnalysisRunsTable = sqliteTable(
  "ai_analysis_runs",
  {
    id: sqliteText("id").primaryKey(),
    conversation_key: sqliteText("conversation_key").notNull(),
    target_message_ids: sqliteText("target_message_ids").notNull(), // JSON array
    model: sqliteText("model").notNull(),
    request_tokens_estimate: sqliteInteger("request_tokens_estimate"),
    response_raw: sqliteText("response_raw"),
    status: sqliteText("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    error: sqliteText("error"),
    created_at: sqliteInteger("created_at").notNull(),
    completed_at: sqliteInteger("completed_at"),
  },
  (table) => ({
    conversationKeyIdx: sqliteIndex("idx_ai_analysis_runs_conversation_key").on(
      table.conversation_key,
    ),
    statusIdx: sqliteIndex("idx_ai_analysis_runs_status").on(table.status),
    createdAtIdx: sqliteIndex("idx_ai_analysis_runs_created_at").on(
      table.created_at,
    ),
  }),
);

// Runtime table selection based on config
// ========================================

export const muxerJobsTable =
  config.DATABASE_TYPE === "postgres" ? pgMuxerJobsTable : sqliteMuxerJobsTable;

export const messagesTable =
  config.DATABASE_TYPE === "postgres" ? pgMessagesTable : sqliteMessagesTable;

export const attachmentsTable =
  config.DATABASE_TYPE === "postgres"
    ? pgAttachmentsTable
    : sqliteAttachmentsTable;

export const uiStateTable =
  config.DATABASE_TYPE === "postgres" ? pgUIStateTable : sqliteUIStateTable;

export const aiAnalysisRunsTable =
  config.DATABASE_TYPE === "postgres"
    ? pgAIAnalysisRunsTable
    : sqliteAIAnalysisRunsTable;

// Export table types for use in queries
export type MuxerJob = typeof muxerJobsTable.$inferSelect;
export type MuxerJobInsert = typeof muxerJobsTable.$inferInsert;

export type Message = typeof messagesTable.$inferSelect;
export type MessageInsert = typeof messagesTable.$inferInsert;

export type Attachment = typeof attachmentsTable.$inferSelect;
export type AttachmentInsert = typeof attachmentsTable.$inferInsert;

export type UIState = typeof uiStateTable.$inferSelect;
export type UIStateInsert = typeof uiStateTable.$inferInsert;

export type AIAnalysisRun = typeof aiAnalysisRunsTable.$inferSelect;
export type AIAnalysisRunInsert = typeof aiAnalysisRunsTable.$inferInsert;
