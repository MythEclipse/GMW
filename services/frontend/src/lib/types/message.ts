// ── AI Moderation Types ──────────────────────────────────────

/**
 * Where a message sits in the moderation QUEUE — not whether it was flagged.
 *
 * `analyzed` means the worker is finished with the message and nothing more.
 * The judgement is `VerdictStatus`, and it is a separate field, because
 * "judged clean" and "not judged yet" used to be the same value
 * (`ai_status === 'clean'`) and no component could tell them apart.
 */
export type AiStatus =
  | "pending"
  | "claimed"
  | "analyzed"
  | "retry_wait"
  | "dead";

/** The moderation outcome. `null` means the message has not been judged. */
export type VerdictStatus = "clean" | "warn" | "flagged" | "error";

export type AiSeverity = "none" | "low" | "medium" | "high" | "critical";

export type AiRecommendedAction =
  | "none"
  | "monitor"
  | "warn"
  | "review"
  | "delete"
  | "escalate";

/** How an analysis attempt ended. Append-only, from `analysis_attempts`. */
export type AttemptOutcome =
  | "success"
  | "llm_error"
  | "parse_error"
  | "abandoned"
  | "duplicate";

export interface AnalysisAttempt {
  attempt: number;
  outcome: AttemptOutcome;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  model: string | null;
  worker_id: string | null;
  prompt_tokens: number | null;
  /** Epoch millis. */
  created_at: number;
}

// ── Embeds & Metadata ────────────────────────────────────────

export interface EmbedMedia {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface EmbedInfo {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: number | null;
  image?: EmbedMedia | null;
  thumbnail?: EmbedMedia | null;
  author?: { name?: string; url?: string; icon_url?: string } | null;
  footer?: { text: string; icon_url?: string } | null;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface StickerInfo {
  name?: string | null;
  url?: string | null;
}

export interface CustomEmojiInfo {
  id: string;
  name: string;
  animated?: boolean;
  url?: string | null;
}

export interface MentionedRoleInfo {
  id: string;
  name: string;
}

export interface MentionedUserInfo {
  id: string;
  username: string;
}

export interface AttachmentRef {
  name: string;
  url: string;
  contentType?: string | null;
}

export interface ChannelRef {
  channelId: string;
  channelName?: string | null;
  threadId?: string | null;
  threadName?: string | null;
  /** Channel topic (captured in gateway metadata.channel.topic). */
  topic?: string | null;
  nsfw?: boolean;
}

export interface ReferenceInfo {
  messageId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  type?: string | null;
  content?: string | null;
  repliedUsername?: string | null;
  repliedUserId?: string | null;
}

export interface MessageMetadata {
  stickers?: StickerInfo[] | null;
  attachments?: AttachmentRef[] | null;
  embeds?: EmbedInfo[] | null;
  customEmojis?: CustomEmojiInfo[] | null;
  mentionedRoles?: MentionedRoleInfo[] | null;
  mentionedUsers?: MentionedUserInfo[] | null;
  channel?: ChannelRef | null;
  reference?: ReferenceInfo | null;
}

// ── Message Record ──────────────────────────────────────────

export interface MessageRecord {
  id: string;
  guild_id: string;
  channel_id: string;
  thread_id?: string | null;
  reference_message_id?: string | null;
  reference_channel_id?: string | null;
  reference_guild_id?: string | null;
  user_id: string;
  username: string;
  /** Member's server-specific display name (nickname), from metadata.member.displayName. Falls back to username. */
  server_nick?: string | null;
  avatar_url?: string | null;
  content: string;
  edited_content?: string | null;
  type: "text" | "edited" | "deleted";
  is_reply?: boolean | null;
  is_forward?: boolean | null;
  is_crosspost?: boolean | null;
  metadata?: string | null; // JSON string of MessageMetadata
  created_at: number;
  edited_at?: number | null;
  deleted_at?: number | null;
  // ── Pipeline state (queue position, not a judgement) ──────────────────
  ai_status?: AiStatus | null;
  /** Retry count. The cap is maxAttempts; `dead` means it ran out. */
  ai_attempts?: number | null;
  /** Worker currently holding the claim lease, if any. */
  ai_worker_id?: string | null;
  /** Epoch millis when the claim lease expires; the sweeper reclaims after. */
  ai_lease_until?: number | null;
  /** Epoch millis before which the worker must not touch this message. */
  ai_ready_for_work_at?: number | null;

  // ── Verdict (the judgement, joined from the `verdicts` table) ───────────
  // `null` = not judged yet. `ai_status: 'analyzed'` + this null means the
  // message is finished but has no verdict row, which is a real state worth
  // showing rather than treating as clean.
  verdict_status?: VerdictStatus | null;
  verdict_severity?: AiSeverity | null;
  verdict_score?: number | null;
  verdict_confidence?: number | null;
  verdict_flags?: string[] | null;
  verdict_categories?: string[] | null;
  verdict_recommended_action?: AiRecommendedAction | null;
  verdict_analysis?: string | null;
  verdict_evidence?: unknown;
  verdict_model?: string | null;
  /** Epoch millis of the last verdict write. */
  verdict_updated_at?: number | null;

  // ── Legacy `messages.ai_*` columns ────────────────────────────────────
  // The rewrite moved all of this into `verdicts`, and the worker writes
  // NOTHING here any more — these stay null for anything judged after the
  // cutover. Kept for older rows; do not build new UI on them.
  ai_severity?: AiSeverity | null;
  ai_confidence?: number | null;
  ai_moderation_flags?: string | null; // JSON string array
  ai_moderation_score?: number | null;
  ai_analysis?: string | null;
  ai_categories?: string | null; // JSON string array
  ai_recommended_action?: AiRecommendedAction | null;
  ai_error?: string | null;
  ai_analyzed_at?: number | null;
  ai_analysis_duration_ms?: number | null;
  /** Detail-only: number of past edits (message_edits snapshots) */
  edit_count?: number;
  /** Detail-only: previous content snapshots, newest first */
  edit_history?: Array<{ old_content: string; edited_at: number }>;
  /**
   * Detail-only: every analysis attempt, oldest first.
   *
   * Detail-only because it is a separate query, and necessary because a
   * message that never produced a verdict has no row in `verdicts` — without
   * this, the most important failure state is invisible in the UI.
   */
  analysis_attempts?: AnalysisAttempt[];
}

// ── Pagination ──────────────────────────────────────────────

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}

// ── Attachment ──────────────────────────────────────────────

export interface AttachmentRecord {
  id: string;
  message_id: string;
  guild_id: string;
  channel_id: string;
  thread_id?: string | null;
  user_id: string;
  filename: string;
  size: number;
  type: string;
  discord_url: string;
  uploaded_url?: string | null;
  upload_status: "pending" | "uploaded" | "failed";
  upload_error?: string | null;
  created_at: number;
  uploaded_at?: number | null;
}

export interface MessageActivityBucket {
  channelId: string;
  channelName: string;
  hour: number;
  count: number;
}
