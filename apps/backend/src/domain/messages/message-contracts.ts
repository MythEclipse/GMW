/**
 * The message contracts shared by the query layer and the use-cases.
 *
 * These moved out of `application/messages/messages.schema.ts` because
 * `infrastructure/repositories/messages.repository.ts` has to read them, and
 * infrastructure may not depend on application. The Zod schemas stay in the
 * application layer and are checked against these types at compile time (see
 * the `Expect<Equal<…>>` assertions there), so the two cannot drift.
 *
 * `created_at` and `updated_at` on rows are milliseconds since the Unix epoch.
 */

/** Pipeline position — where a message sits in the moderation queue. */
export type PipelineStatus =
	| "pending"
	| "claimed"
	| "analyzed"
	| "retry_wait"
	| "skipped"
	| "dead"

/**
 * The judgement itself. Lives in the `verdicts` table, not on `messages`.
 *
 * `analyzed` says the worker finished with a message; it says nothing about
 * whether the message was clean. That distinction is why the two are separate.
 */
export type VerdictStatus = "clean" | "deleted" | "error"

/** Filters accepted when listing messages. */
export interface MessageQuery {
	channelId?: string
	guildId?: string
	userId?: string
	/** Filter by pipeline position. `dead` is the one meaning "needs a human". */
	status?: PipelineStatus
	/**
	 * Filter by moderation OUTCOME. Joins `verdicts`; a message with no verdict
	 * yet never matches, which is the point.
	 */
	verdict?: VerdictStatus
	/**
	 * Shorthand for the enforcement queue: verdict is `deleted`. The name is
	 * historical — there is no review tier any more.
	 */
	needsReview?: boolean
	limit: number
	offset: number
	cursor?: string
	/** Restrict attachments to a single message (message detail view). */
	messageId?: string
}

/** A message as captured from Discord. */
export interface MessageCreate {
	guildId: string
	channelId: string
	threadId?: string
	userId: string
	username: string
	avatarUrl?: string
	content: string
	type: "text" | "edited" | "deleted"
	isReply?: boolean
	isForward?: boolean
	isCrosspost?: boolean
	referenceMessageId?: string
	referenceChannelId?: string
	referenceGuildId?: string
}

/**
 * Manual overrides, e.g. a moderator marking a reviewed message.
 *
 * `aiStatus` is a pipeline position the backend never advances on its own —
 * only the gateway's worker does. `verdictStatus` IS writable here, but it
 * writes to `verdicts`, not to `messages.ai_status`.
 */
export interface MessageUpdate {
	editedContent?: string
	aiStatus?: PipelineStatus
	verdictStatus?: VerdictStatus
	recommendedAction?: "clean" | "deleted"
	analysis?: string
	categories?: string
	confidence?: number
	/** Legacy camelCase aliases the dashboard still sends. */
	aiAnalysis?: string
	aiCategories?: string
	aiConfidence?: number
}
