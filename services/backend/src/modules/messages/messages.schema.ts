import { z } from "zod";

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
]);

/** The judgement itself. Lives in the `verdicts` table, not on `messages`. */
export const verdictStatusSchema = z.enum([
  "clean",
  "warn",
  "flagged",
  "error",
]);

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
  /** Shorthand for the review queue: verdict in (warn, flagged). */
  needsReview: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  cursor: z.string().optional(),
  // Filter attachments to a single message (used by the message detail view)
  messageId: z.string().optional(),
});

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
});

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
  recommendedAction: z.string().optional(),
  analysis: z.string().optional(),
  categories: z.string().optional(),
  severity: z.enum(["none", "low", "medium", "high", "critical"]).optional(),
  confidence: z.number().optional(),
  // Legacy camelCase aliases the dashboard still sends.
  aiAnalysis: z.string().optional(),
  aiCategories: z.string().optional(),
  aiSeverity: z.enum(["none", "low", "medium", "high", "critical"]).optional(),
  aiConfidence: z.number().optional(),
});

export type MessageQuery = z.infer<typeof messageQuerySchema>;
export type MessageCreate = z.infer<typeof messageCreateSchema>;
export type MessageUpdate = z.infer<typeof messageUpdateSchema>;
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;
export type VerdictStatus = z.infer<typeof verdictStatusSchema>;
