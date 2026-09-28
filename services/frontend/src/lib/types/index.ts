/**
 * Local domain types for the dashboard.
 *
 * These are hand-maintained on purpose. The backend router is not imported
 * here: the frontend is a separate deployable with its own build, and coupling
 * it to backend generics would mean a backend schema change breaks the FE
 * typecheck for no benefit. Every call site asserts the backend's response to
 * one of these types, so a drift shows up as a wrong render, not a silent lie.
 *
 * Field names are snake_case because that is what the backend actually returns
 * (it is Drizzle over Postgres, no serialization layer).
 */

// ── Moderation state machine ────────────────────────────────────────────────

/**
 * QUEUE position, not the outcome. `messages.ai_status` has a hard CHECK
 * constraint in migration 0020 allowing exactly these five values.
 *
 * The v1 names ("processing", "clean", "warn", "flagged", "error") are NOT
 * valid here — a query filtering on them matches nothing, which is how the
 * review queue once rendered permanently empty.
 */
export type PipelineStatus =
  | "pending"
  | "claimed"
  | "analyzed"
  | "retry_wait"
  | "dead";

/**
 * The JUDGEMENT, from the `verdicts` table. A separate column from
 * `ai_status` and never stored there.
 */
export type VerdictStatus = "clean" | "warn" | "flagged" | "error";

export type Severity = "none" | "low" | "medium" | "high" | "critical";

export type RecommendedAction =
  | "none"
  | "monitor"
  | "warn"
  | "review"
  | "delete"
  | "escalate";

export type ModerationActionType =
  | "delete_message"
  | "mute_user"
  | "warn_user"
  | "kick_user"
  | "ban_user"
  | "reset_nickname";

export type ActionExecutionStatus = "pending" | "executed" | "failed";

/**
 * The verdict as the dashboard reads it. The backend coalesces a missing
 * verdict row to the string `"unjudged"`, so that is a real value the UI must
 * handle — it means "the worker has not concluded yet", NOT "judged clean".
 */
export type DisplayVerdict = VerdictStatus | "unjudged";

// ── Messages ────────────────────────────────────────────────────────────────

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
}

export interface TextChannel {
  id: string;
  name: string;
  type: string;
}

/** The judgement, joined onto a message by the backend. */
export interface VerdictFields {
  verdict_status?: VerdictStatus | null;
  verdict_severity?: Severity | null;
  verdict_score?: number | null;
  verdict_confidence?: number | null;
  verdict_flags?: string[] | null;
  verdict_categories?: string[] | null;
  verdict_recommended_action?: RecommendedAction | null;
  verdict_analysis?: string | null;
  verdict_evidence?: string[] | null;
  verdict_model?: string | null;
  verdict_policy_version?: string | null;
  verdict_updated_at?: number | null;
}

export interface Message extends VerdictFields {
  id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  username: string;
  server_nick: string | null;
  avatar_url: string | null;
  content: string;
  edited_content: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  type: string;
  metadata: string | null;
  is_reply: boolean | null;
  is_forward: boolean | null;
  is_crosspost: boolean | null;
  reference_message_id: string | null;
  reference_channel_id: string | null;
  reference_guild_id: string | null;
  ai_status?: PipelineStatus | null;
  attempts?: number | null;
  worker_id?: string | null;
  // Legacy columns kept for the review row; the verdict_* fields are canonical.
  ai_severity?: Severity | null;
  ai_confidence?: number | null;
  ai_analysis?: string | null;
  ai_categories?: string | null;
}

export interface MessageQuery {
  channelId?: string;
  guildId?: string;
  userId?: string;
  status?: PipelineStatus;
  verdict?: VerdictStatus;
  needsReview?: boolean;
  limit?: number;
  offset?: number;
  cursor?: string;
  messageId?: string;
}

export interface MessagePage {
  data: Message[];
  nextCursor: string | null;
}

export interface Attachment {
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

export interface MessageEdit {
  id: string;
  message_id: string;
  old_content: string;
  new_content: string;
  edited_at: number;
  channel_id: string;
  channel_name: string | null;
  username: string | null;
}

export interface ActivityCell {
  channelId: string;
  channelName: string;
  hour: number;
  count: number;
}

export interface AnalysisAttempt {
  id?: string;
  message_id?: string;
  outcome?: string;
  error?: string | null;
  model?: string | null;
  duration_ms?: number | null;
  created_at?: number;
  finished_at?: number | null;
  [key: string]: unknown;
}

export interface MessageDetail extends Message {
  edit_count: number;
  edit_history: MessageEdit[];
  analysis_attempts: AnalysisAttempt[];
}

export interface ReviewResult {
  results: Message[];
  limit: number;
  cursor: string | null;
}

// ── Dashboard ───────────────────────────────────────────────────────────────

export interface TopChannel {
  channel_id: string;
  channel_name: string;
  message_count: number;
}

export interface QueueOverview {
  pending: number;
  claimed: number;
  retry_wait: number;
  dead: number;
  error: number;
}

export interface DashboardStats {
  total_messages: number;
  total_users: number;
  total_flagged: number;
  total_clean: number;
  total_warned: number;
  total_error: number;
  total_pending: number;
  total_claimed: number;
  total_retry_wait: number;
  total_dead: number;
  total_voice_recordings: number;
  total_profiles: number;
  today_messages: number;
  today_flagged: number;
  active_users_24h: number;
  top_channels: TopChannel[];
  moderation_overview: QueueOverview;
}

export interface DailyActivity {
  day: string;
  messages: number;
  flagged: number;
  active_users: number;
}

export interface HourlyActivity {
  hour: number;
  messages: number;
  flagged: number;
}

export interface DashboardActivity {
  days: number;
  daily: DailyActivity[];
  hourly: HourlyActivity[];
}

export interface UserSummary {
  user_id: string;
  username: string;
  avatar_url: string | null;
  profile_summary: string | null;
  total_messages?: number;
  flagged_count?: number;
  last_seen_at?: number | null;
  [key: string]: unknown;
}

export interface UserPage {
  data: UserSummary[];
  nextCursor: string | null;
}

export interface ChannelSummary {
  channel_id: string;
  channel_name: string;
  guild_id: string;
  total_messages: number;
  flagged_count: number;
  last_message_at: number | null;
  culture_summary: string | null;
  last_analyzed_at: number | null;
}

export interface ChannelPage {
  data: ChannelSummary[];
  nextCursor: string | null;
}

export interface ChannelDetail extends ChannelSummary {
  clean_count: number;
  recent_messages: Array<
    Pick<
      Message,
      "id" | "content" | "channel_id" | "created_at" | "ai_status" | "username"
    >
  >;
}

export interface TopReaction {
  message_id: string;
  content: string;
  username: string;
  channel_id: string;
  channel_name: string | null;
  created_at: number;
  reaction_count: number;
  top_emojis: Array<{ emoji: string; count: number }>;
}

export interface TopReactor {
  user_id: string;
  username: string;
  net_count: number;
  adds_count: number;
  messages_reacted: number;
  emojis_used: number;
}

// ── Moderation ──────────────────────────────────────────────────────────────

export interface ModerationStats {
  total: number;
  executed: number;
  failed: number;
  pending: number;
  failed_rate: number;
  by_action: Record<
    string,
    { executed: number; failed: number; pending: number }
  >;
}

export interface ModerationTrends {
  categories: Array<{ name: string; count: number }>;
  severities: Array<{ level: string; count: number }>;
  actions: Array<{ type: string; count: number }>;
}

export interface FlaggedDomain {
  domain: string;
  count: number;
}

export interface FlaggedChannel {
  channel_id: string;
  channel_name: string | null;
  flagged_count: number;
}

export interface HourBucket {
  hour: number;
  total: number;
}

export interface ModerationActionRow {
  id: string;
  message_id: string | null;
  user_id: string | null;
  guild_id: string;
  action_type: string;
  reason: string | null;
  executed_by: string | null;
  status: string;
  error: string | null;
  created_at: number;
  executed_at: number | null;
  flags: string[] | null;
  categories: string[] | null;
  severity: Severity | null;
  confidence: number | null;
  score: number | null;
  evidence: string[] | null;
  policy_version: string | null;
  username: string | null;
  server_nick: string | null;
  content: string | null;
}

export interface ModerationActionPage {
  data: ModerationActionRow[];
  nextCursor: string | null;
}

export interface CategoryDrilldownRow {
  id: string;
  message_id: string | null;
  user_id: string | null;
  guild_id: string;
  action_type: string;
  reason: string | null;
  status: string;
  created_at: number;
  severity: Severity | null;
  confidence: number | null;
  score: number | null;
  username: string | null;
  server_nick: string | null;
  content: string | null;
}

export interface Coverage {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  outcomes: Record<string, number>;
  coverage_rate: number;
  failed_rate: number;
}

// ── Knowledge ───────────────────────────────────────────────────────────────

export interface ChannelCulture {
  channel_id: string;
  guild_id: string;
  channel_name: string;
  culture_summary: string;
  [key: string]: unknown;
}

export interface GlossaryTerm {
  term: string;
  definition: string;
  source_url: string | null;
  resolved_at: number;
  hit_count: number;
}

// ── Chatbot / config / ui-state ─────────────────────────────────────────────

export interface ChatbotTurn {
  id: string;
  user_id: string;
  user_message: string;
  bot_response: string;
  context: string | null;
  created_at: number;
}

export interface ChatbotHistoryResult {
  history: ChatbotTurn[];
  total: number;
}

export interface AppConfig {
  monitorGuildId: string | null;
  webserverPort: number;
  nodeEnv: string;
  backlogSyncHours: number;
  backlogSyncBatchSize: number;
  retentionMessagesDays: number;
  retentionAttachmentsDays: number;
  autoDeleteFlaggedEnabled: boolean;
  aiAnalysisEnabled: boolean;
  logLevel: string;
}

export type UiState = Record<string, unknown>;
