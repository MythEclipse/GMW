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
  ai_status?: "pending" | "clean" | "flagged" | "error" | null;
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
