export type ModerationActionType =
  | "delete_message"
  | "mute_user"
  | "warn_user"
  | "kick_user"
  | "ban_user";

export type ModerationStatus = "pending" | "executed" | "failed";

export interface ModerationAction {
  id: string;
  message_id: string | null;
  user_id: string | null;
  guild_id: string;
  action_type: ModerationActionType;
  reason: string | null;
  executed_by: string | null;
  status: ModerationStatus;
  error: string | null;
  created_at: number | null;
  executed_at: number | null;
  username: string | null;
  server_nick: string | null;
  content: string | null;
  // ── Explainability (structured verdict, surfaced read-only to public web) ──
  flags: string[] | null;
  categories: string[] | null;
  severity: "none" | "low" | "medium" | "high" | "critical" | null;
  confidence: number | null;
  score: number | null;
  evidence: string[] | null;
  policy_version: string | null;
}

/**
 * Headline counts.
 *
 * Repointed off `moderation_actions` when the gateway rewrite removed
 * gateway-side enforcement. The field NAMES are unchanged so the dashboard
 * keeps compiling, but the MEANING shifted:
 *   - `executed` = verdicts that call for action (clean/warn/flagged)
 *   - `failed`   = errored verdicts
 *   - `pending`  = messages with no verdict yet
 * `by_action` is now keyed by `verdicts.recommended_action` rather than a
 * moderation action type.
 */
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

/** Queue health straight from `messages.ai_status`. */
export interface QueueStats {
  by_status: Record<string, number>;
  pending: number;
  claimed: number;
  retry_wait: number;
  /** Ran out of attempts. The only state that requires a human. */
  dead: number;
}

export interface PaginatedModerationActions {
  data: ModerationAction[];
  nextCursor: string | null;
}

export interface ModerationTrends {
  categories: { name: string; count: number }[];
  severities: { level: string; count: number }[];
  actions: { type: string; count: number }[];
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

export interface HourlyModeration {
  hour: number;
  total: number;
}

export interface CategoryAction {
  id: string;
  message_id: string | null;
  user_id: string | null;
  guild_id: string;
  action_type: ModerationActionType;
  reason: string | null;
  status: ModerationStatus;
  created_at: number | null;
  severity: "none" | "low" | "medium" | "high" | "critical" | null;
  confidence: number | null;
  score: number | null;
  username: string | null;
  server_nick: string | null;
  content: string | null;
}

/**
 * Attempt success rate.
 *
 * Now computed from `analysis_attempts` (append-only) instead of the deleted
 * `ai_analysis_runs`, so it reports the real number rather than a permanent 0.
 * `outcomes` breaks the result down per outcome so the UI can separate model
 * timeouts from parse failures.
 */
export interface ModerationCoverage {
  total: number;
  completed: number;
  failed: number;
  /** Messages still owed work: pending + claimed + retry_wait. */
  pending: number;
  coverage_rate: number;
  failed_rate: number;
  outcomes?: Record<string, number>;
}
