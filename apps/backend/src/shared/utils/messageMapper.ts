// Shared message row mapper for backend repository modules

function resolveServerNick(row: Record<string, unknown>): string | null {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "string") {
    return (row.username as string | null) ?? null;
  }
  try {
    const parsed = JSON.parse(metadata) as {
      member?: { displayName?: string | null } | null;
    };
    return (
      parsed?.member?.displayName ?? (row.username as string | null) ?? null
    );
  } catch {
    return (row.username as string | null) ?? null;
  }
}

export interface MappedMessage {
  id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  username: string;
  /** Member's server-specific display name (nickname), from metadata.member.displayName. Falls back to username when absent. */
  server_nick: string | null;
  avatar_url: string | null;
  content: string;
  edited_content: string | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  type: string;
  metadata: string | null;
  ai_status: string | null;
  // Claim/retry bookkeeping from `messages`
  attempts?: number | null;
  worker_id?: string | null;
  lease_until?: number | null;
  ready_for_work_at?: number | null;
  // The mapper's OUTPUT names for that bookkeeping — kept under the `ai_`
  // prefix so existing dashboard code can find them next to ai_status.
  /** Retry count; the cap is maxAttempts. `dead` means it ran out. */
  ai_attempts: number | null;
  /** Worker currently holding the claim lease, if any. */
  ai_worker_id: string | null;
  /** Epoch millis when the current claim lease expires. */
  ai_lease_until: number | null;
  /** Epoch millis before which the worker must not touch this message. */
  ai_ready_for_work_at: number | null;
  // Joined verdict columns (aliased `verdict_*` by the repository)
  verdict_status?: string | null;
  verdict_score?: number | null;
  verdict_confidence?: number | null;
  verdict_flags?: string[] | null;
  verdict_categories?: string[] | null;
  /** Why the model deleted it. Null for a clean verdict and for pre-0025 rows. */
  verdict_reason?: string | null;
  verdict_analysis?: string | null;
  verdict_evidence?: unknown;
  verdict_model?: string | null;
  verdict_updated_at?: number | null;
  // Written only by the gateway's auto-delete enforcer. Non-null here means
  // THE BOT deleted the message; null plus a deleted_at means a human did.
  auto_delete_state?: string | null;
  ai_moderation_flags: string | null;
  ai_moderation_score: number | null;
  ai_analysis: string | null;
  ai_categories: string | null;
  ai_confidence: number | null;
  ai_analyzed_at: number | null;
  ai_analysis_duration_ms: number | null;
  ai_error: string | null;
  is_reply: boolean | null;
  is_forward: boolean | null;
  is_crosspost: boolean | null;
  reference_message_id: string | null;
  reference_channel_id: string | null;
  reference_guild_id: string | null;
}

export function mapMessageRow(row: Record<string, unknown>): MappedMessage {
  return {
    id: String(row.id ?? ""),
    guild_id: String(row.guild_id ?? ""),
    channel_id: String(row.channel_id ?? ""),
    thread_id: (row.thread_id as string | null) ?? null,
    user_id: String(row.user_id ?? ""),
    username: String(row.username ?? ""),
    server_nick: resolveServerNick(row),
    avatar_url: (row.avatar_url as string | null) ?? null,
    content: String(row.content ?? ""),
    edited_content: (row.edited_content as string | null) ?? null,
    created_at: Number(row.created_at ?? 0),
    edited_at: (row.edited_at as number | null) ?? null,
    deleted_at: (row.deleted_at as number | null) ?? null,
    type: String(row.type ?? "text"),
    metadata: (row.metadata as string | null) ?? null,
    // Pipeline position, NOT the judgement. `analyzed` only means the worker is
    // finished with this message. The moderation outcome is `verdict_status`
    // below, which comes from the `verdicts` table.
    ai_status: (row.ai_status as string | null) ?? null,
    // Retry bookkeeping, so the dashboard can show stuck work without a second
    // query. `dead` is the state that means "a human must look at this".
    ai_attempts: (row.attempts as number | null) ?? null,
    ai_worker_id: (row.worker_id as string | null) ?? null,
    ai_lease_until: (row.lease_until as number | null) ?? null,
    ai_ready_for_work_at: (row.ready_for_work_at as number | null) ?? null,
    // ── Verdict (from `verdicts`, joined by the repository) ────────────────
    // null means "not judged yet" — which is now distinguishable from
    // "judged clean". Before the split those were the same value.
    verdict_status: (row.verdict_status as string | null) ?? null,
    verdict_score: (row.verdict_score as number | null) ?? null,
    verdict_confidence: (row.verdict_confidence as number | null) ?? null,
    verdict_flags: (row.verdict_flags as string[] | null) ?? null,
    verdict_categories: (row.verdict_categories as string[] | null) ?? null,
    verdict_reason: (row.verdict_reason as string | null) ?? null,
    verdict_analysis: (row.verdict_analysis as string | null) ?? null,
    verdict_evidence: (row.verdict_evidence as unknown) ?? null,
    verdict_model: (row.verdict_model as string | null) ?? null,
    verdict_updated_at: (row.verdict_updated_at as number | null) ?? null,
    auto_delete_state: (row.auto_delete_state as string | null) ?? null,
    // Legacy `messages.ai_*` columns. The new worker writes NOTHING here, so
    // these stay null for anything analysed after the rewrite; kept for older
    // rows and existing frontend code paths.
    ai_moderation_flags: (row.ai_moderation_flags as string | null) ?? null,
    ai_moderation_score: (row.ai_moderation_score as number | null) ?? null,
    ai_analysis: (row.ai_analysis as string | null) ?? null,
    ai_categories: (row.ai_categories as string | null) ?? null,
    ai_confidence: (row.ai_confidence as number | null) ?? null,
    ai_analyzed_at: (row.ai_analyzed_at as number | null) ?? null,
    ai_analysis_duration_ms:
      (row.ai_analysis_duration_ms as number | null) ?? null,
    ai_error: (row.ai_error as string | null) ?? null,
    is_reply: row.is_reply === null ? null : Boolean(row.is_reply),
    is_forward: row.is_forward === null ? null : Boolean(row.is_forward),
    is_crosspost: row.is_crosspost === null ? null : Boolean(row.is_crosspost),
    reference_message_id: (row.reference_message_id as string | null) ?? null,
    reference_channel_id: (row.reference_channel_id as string | null) ?? null,
    reference_guild_id: (row.reference_guild_id as string | null) ?? null,
  };
}
