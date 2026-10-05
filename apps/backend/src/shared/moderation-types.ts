// Shared moderation types for all services
// Source of truth — snake_case + number (matching PostgreSQL schema)

/**
 * The QUEUE state, not the judgement.
 *
 * Migration 0020 replaced the v1 set with a hard CHECK constraint:
 *   CHECK (ai_status IN ('pending','claimed','analyzed','retry_wait','dead','skipped'))
 * so the v1 values ("processing", "clean", "warn", "flagged", "error") are
 * rejected by the database. Declaring them here let code type-check against a
 * state that can never be written. The judgement is `verdicts.status`
 * ("clean" | "warn" | "flagged" | "error"), a separate column entirely.
 */
export type AIStatus =
	| "pending"
	| "claimed"
	| "analyzed"
	| "retry_wait"
	| "dead"
	| "skipped"

/**
 * The verdict, from the `verdicts` table. Never stored in `ai_status`.
 *
 * Two real answers and one non-answer: a message either violates the policy
 * (`deleted`) or it does not (`clean`). There is no `warn`/`flagged` middle
 * tier, because a middle tier in practice meant "nobody acted on this" — the
 * message stayed up while the pipeline called it handled. `error` is not a
 * middle tier; it means the model could not read the message at all, which is a
 * different thing entirely and still never authorises a deletion.
 */
export type VerdictStatus = "clean" | "deleted" | "error"

export interface BroadcasterClient {
	messageCreated: (data: unknown) => void
	messageUpdated: (data: unknown) => void
	messageDeleted: (data: unknown) => void
	messageAnalyzed: (data: unknown) => void
	attachmentCreated: (data: unknown) => void
	attachmentUploaded: (data: unknown) => void
	analysisQueueStatus: (data: unknown) => void
}

export type ModerationBroadcaster = BroadcasterClient

export interface RoleMetadata {
	id: string
	name: string
	position: number
}

export interface UserMetadata {
	userId: string
	username: string
	tag: string
	displayName: string
	avatarUrl: string
	bot: boolean
	roles: RoleMetadata[]
	highestRole: RoleMetadata | null
	joinedTimestamp: number | null
}

export interface MessageRecord {
	id: string
	guild_id: string
	channel_id: string
	thread_id: string | null
	user_id: string
	username: string
	avatar_url: string | null
	content: string
	edited_content: string | null
	created_at: number
	edited_at: number | null
	deleted_at: number | null
	type: "text" | "edited" | "deleted"
	is_reply: boolean | null
	is_forward: boolean | null
	is_crosspost: boolean | null
	reference_message_id: string | null
	reference_channel_id: string | null
	reference_guild_id: string | null
	metadata: string | null
	ai_status?: AIStatus | null
	ai_moderation_flags?: string | null
	ai_moderation_score?: number | null
	ai_analysis?: string | null
	ai_categories?: string | null
	ai_confidence?: number | null
	ai_analyzed_at?: number | null
	ai_error?: string | null
	// ── The JUDGEMENT (from `verdicts`, joined by the backend) ───────────────
	//
	// `ai_status` is the QUEUE position and only ever says whether the worker
	// is finished; it never carries the outcome. Without these fields a
	// consumer of this record cannot tell "judged clean" from "not judged yet",
	// and the dashboard badge falls back to rendering "unjudged".
	verdict_status?: VerdictStatus | null
	/** Why the model deleted it. Required for a `deleted` verdict so the
	 *  decision is auditable and appealable. */
	verdict_reason?: string | null
	verdict_score?: number | null
	verdict_confidence?: number | null
	verdict_flags?: string[] | null
	verdict_categories?: string[] | null
	verdict_analysis?: string | null
	verdict_model?: string | null
	verdict_policy_version?: string | null
	/** Wall-clock LLM time for the judgement, in ms. Written on the verdict
	 *  row, not on `messages`. */
	ai_analysis_duration_ms?: number | null
}

export interface AttachmentRecord {
	id: string
	message_id: string
	guild_id: string
	channel_id: string
	thread_id: string | null
	user_id: string
	filename: string
	size: number
	type: string
	discord_url: string
	uploaded_url: string | null
	upload_status: "pending" | "uploaded" | "failed"
	upload_error: string | null
	created_at: number
	uploaded_at: number | null
}

export interface DashboardMessage {
	id: string
	channel_id: string
	user_id: string
	username: string
	avatar_url: string | null
	content: string
	created_at: number
	type: "text" | "image" | "voice"
}

export interface MessageQuery {
	guildId?: string
	channelId?: string
	threadId?: string
	status?: AIStatus[]
	userId?: string
	q?: string
	cursor?: string
	limit: number
}

export interface PageResult<T> {
	data: T[]
	nextCursor: string | null
}

export interface AnalysisResult {
	messageId: string
	status: Exclude<AIStatus, "pending">
	flags: string[]
	score: number
	analysis: string
	categories?: string[]
	confidence?: number
	policyVersion?: string
	evidence?: string[]
}

export interface AnalysisQueueStatus {
	queuedConversations: number
	activeRequests: number
	activeIndividualRequests: number
	individualInFlightCount: number
	individualCircuitBreakerActive: boolean
	lastError: string | null
	/** Active batch worker jobs on the text lane (2026-09-24). */
	activeTextRequests?: number
	/** Active batch worker jobs on the media lane (2026-09-24). */
	activeMediaRequests?: number
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "escalated"

export interface MessageReview {
	id: string
	message_id: string
	guild_id: string
	channel_id: string
	reviewer_id: string | null
	status: ReviewStatus
	notes: string | null
	created_at: number
	reviewed_at: number | null
}

export type ModerationActionType = "delete_message" | "reset_nickname"

export interface ModerationAction {
	id: string
	message_id: string | null
	user_id: string | null
	guild_id: string
	action_type: ModerationActionType
	reason: string | null
	username: string | null
	server_nick: string | null
	executed_by: string | null
	status: "pending" | "executed" | "failed"
	error: string | null
	created_at: number
	executed_at: number | null
}

export interface RetentionPolicy {
	id: string
	guild_id: string
	channel_id: string | null
	retention_days: number
	apply_to_media: boolean
	apply_to_voice: boolean
	enabled: boolean
	created_at: number
	updated_at: number
}
