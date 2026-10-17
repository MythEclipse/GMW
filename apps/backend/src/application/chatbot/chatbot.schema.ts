import { z } from "zod"

export const contextSchema = z.object({
	messageCount: z.number().int().nonnegative().optional(),
	activeParticipants: z.number().int().nonnegative().optional(),
	lastActivity: z.string().datetime().optional(),
	topicsDiscussed: z.array(z.string()).optional(),
	guildId: z.string().optional(),
	channelId: z.string().optional(),
})

export const chatRequestSchema = z.object({
	message: z.string().min(1, "Message is required"),
	context: contextSchema.optional(),
})

/**
 * The history query's schema is NOT here.
 *
 * `chatbot.history` validates its own inline `limit` in the router, and
 * `chatbot.clearHistory` takes no input at all, so a `chatHistoryQuerySchema`
 * in this file was a second declaration of a shape nothing imported. Same for
 * `chatResponseSchema`: the chat procedure's return value is whatever
 * `processMessage` produces, and nothing parses it against a schema.
 */
