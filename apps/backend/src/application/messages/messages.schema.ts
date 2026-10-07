import { z } from "zod"
import type {
	MessageCreate,
	MessageQuery,
	MessageUpdate,
	PipelineStatus,
	VerdictStatus,
} from "../../domain/messages/message-contracts.js"

/**
 * Pipeline position — where a message is in the moderation queue.
 *
 * This is NOT the moderation outcome. `analyzed` means "the worker finished
 * with this message", and says nothing about whether it was clean or flagged;
 * that is `verdictStatus`. The two were one column until the rewrite, which
 * made "not judged yet" and "judged clean" indistinguishable in a single
 * query, and left every `status=flagged` filter silently returning nothing.
 */
export const pipelineStatusSchema = z.enum([
	"pending",
	"claimed",
	"analyzed",
	"retry_wait",
	"skipped",
	"dead",
])

/** The judgement itself. Lives in the `verdicts` table, not on `messages`. */
export const verdictStatusSchema = z.enum(["clean", "deleted", "error"])

export const messageQuerySchema = z.object({
	channelId: z.string().optional(),
	guildId: z.string().optional(),
	userId: z.string().optional(),
	/**
	 * Filter by pipeline position. `dead` is the useful one here — it is the
	 * only state that means "a human needs to look at this".
	 */
	status: pipelineStatusSchema.optional(),
	/**
	 * Filter by moderation OUTCOME. Joins `verdicts`; a message with no verdict
	 * yet never matches, which is the point.
	 */
	verdict: verdictStatusSchema.optional(),
	/**
	 * Shorthand for the enforcement queue: verdict is `deleted`. The name is
	 * historical — there is no review tier any more, so this no longer means
	 * "needs a human to look". It is the set of messages the pipeline removed,
	 * kept under the old name because the frontend filter and the route both
	 * still speak it.
	 */
	needsReview: z.coerce.boolean().optional(),
	limit: z.coerce.number().int().positive().default(50),
	offset: z.coerce.number().int().nonnegative().default(0),
	cursor: z.string().optional(),
	// Filter attachments to a single message (used by the message detail view)
	messageId: z.string().optional(),
})

export const messageCreateSchema = z.object({
	guildId: z.string(),
	channelId: z.string(),
	threadId: z.string().optional(),
	userId: z.string(),
	username: z.string(),
	avatarUrl: z.string().optional(),
	content: z.string(),
	type: z.enum(["text", "edited", "deleted"]).default("text"),
	isReply: z.boolean().optional(),
	isForward: z.boolean().optional(),
	isCrosspost: z.boolean().optional(),
	referenceMessageId: z.string().optional(),
	referenceChannelId: z.string().optional(),
	referenceGuildId: z.string().optional(),
})

/**
 * Manual overrides, e.g. a moderator marking a reviewed message.
 *
 * `aiStatus` is a pipeline position and the backend never advances it on its
 * own — only the gateway's worker does. `verdictStatus` is a judgement and IS
 * writable here, but it writes to `verdicts`, not to `messages.ai_status`.
 */
export const messageUpdateSchema = z.object({
	editedContent: z.string().optional(),
	aiStatus: pipelineStatusSchema.optional(),
	verdictStatus: verdictStatusSchema.optional(),
	recommendedAction: z.enum(["clean", "deleted"]).optional(),
	analysis: z.string().optional(),
	categories: z.string().optional(),
	confidence: z.number().optional(),
	// Legacy camelCase aliases the dashboard still sends.
	aiAnalysis: z.string().optional(),
	aiCategories: z.string().optional(),
	aiConfidence: z.number().optional(),
})

export type {
	MessageCreate,
	MessageQuery,
	MessageUpdate,
	PipelineStatus,
	VerdictStatus,
}

/**
 * The domain owns these five shapes; the Zod schemas above must produce
 * exactly them. `Expect<Equal<A, B>>` compiles only when the two are
 * identical, so editing a schema without its contract — or vice versa — is a
 * `tsc` error rather than a silent drift between the validation boundary and
 * the repository that reads the rows.
 */
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
type Expect<T extends true> = T

export type MessageSchemaContracts = [
	Expect<Equal<z.infer<typeof messageQuerySchema>, MessageQuery>>,
	Expect<Equal<z.infer<typeof messageCreateSchema>, MessageCreate>>,
	Expect<Equal<z.infer<typeof messageUpdateSchema>, MessageUpdate>>,
	Expect<Equal<z.infer<typeof pipelineStatusSchema>, PipelineStatus>>,
	Expect<Equal<z.infer<typeof verdictStatusSchema>, VerdictStatus>>,
]
