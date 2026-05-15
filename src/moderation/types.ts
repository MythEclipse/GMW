import type { BroadcasterClient, ModerationBroadcaster } from "./broadcaster";

export type AIStatus = "pending" | "clean" | "warn" | "flagged" | "error";

export type { BroadcasterClient, ModerationBroadcaster };

export interface MessageRecord {
  id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  username: string;
  avatar_url: string | null;
  content: string;
  edited_content: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  type: "text" | "edited" | "deleted";
  metadata: string | null;
  ai_status?: AIStatus | null;
  ai_moderation_flags?: string | null;
  ai_moderation_score?: number | null;
  ai_moderation_raw?: string | null;
  ai_analysis?: string | null;
  ai_analyzed_at?: number | null;
  ai_error?: string | null;
}

export interface AttachmentRecord {
  id: string;
  message_id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  filename: string;
  size: number;
  type: string;
  discord_url: string;
  uploaded_url: string | null;
  upload_status: "pending" | "uploaded" | "failed";
  upload_error: string | null;
  created_at: number;
  uploaded_at: number | null;
}

export interface VoiceSegmentRecord {
  id: string;
  user_id: string;
  session_id: string;
  guild_id: string;
  channel_id: string;
  filename: string;
  duration_ms: number;
  created_at: number;
}

export interface DashboardMessage {
  id: string;
  channel_id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  content: string;
  created_at: number;
  type: "text" | "image" | "voice";
}

export interface MessageQuery {
  guildId?: string;
  channelId?: string;
  threadId?: string;
  status?: AIStatus[];
  userId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}

export interface AnalysisResult {
  messageId: string;
  status: Exclude<AIStatus, "pending" | "error">;
  flags: string[];
  score: number;
  analysis: string;
}

export type MediaMode = "music" | "screen";
export type MediaSourceKind =
  | "url"
  | "local"
  | "youtube"
  | "spotify"
  | "search";
export type MediaQueueItemStatus = "queued" | "playing" | "failed";

export interface MediaQueueItem {
  id: string;
  mode: MediaMode;
  source: string;
  title: string;
  kind: MediaSourceKind;
  requestedBy: string;
  addedAt: number;
  status: MediaQueueItemStatus;
}

export interface MediaState {
  playing: boolean;
  current: MediaQueueItem | null;
  queue: MediaQueueItem[];
}

export type ModerationWsEvent =
  | { type: "ui_state"; state: unknown }
  | { type: "user_state"; users: unknown[] }
  | { type: "message_created"; data: MessageRecord }
  | { type: "message_updated"; data: Partial<MessageRecord> & { id: string } }
  | { type: "message_deleted"; data: { id: string; deleted_at: number } }
  | { type: "message_analyzed"; data: MessageRecord }
  | { type: "attachment_created"; data: AttachmentRecord }
  | { type: "analysis_queue_status"; data: AnalysisQueueStatus }
  | { type: "media_state"; state: MediaState };

export interface AnalysisQueueStatus {
  queuedConversations: number;
  activeRequests: number;
  lastError: string | null;
}
