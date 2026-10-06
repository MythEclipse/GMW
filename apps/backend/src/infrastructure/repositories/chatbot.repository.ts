import { desc, eq } from "drizzle-orm"
import { getDatabase } from "../database/drizzle.js"
import type { DatabaseHandle } from "../database/handle.js"
import { chatbotMessagesTable } from "../database/schema.js"
import { createChildLogger } from "../logger/index.js"

const logger = createChildLogger("chatbot.repository")

export interface ChatbotContext {
	messageCount?: number
	activeParticipants?: number
	lastActivity?: string
	topicsDiscussed?: string[]
	guildId?: string
	channelId?: string
}

export interface SaveConversationInput {
	userId: string
	userMessage: string
	botResponse: string
	context?: ChatbotContext
	timestamp: Date
}

export interface ChatbotHistoryRow {
	id: string
	user_id: string
	user_message: string
	bot_response: string
	context: ChatbotContext | null
	/**
	 * Epoch milliseconds, NOT an ISO string.
	 *
	 * `chatbot_messages.created_at` is a bigint column and the query below
	 * returns `Number(r.created_at)`. This said `string`, which nothing caught
	 * until P4 gave the frontend oRPC's real `RouterClient` type — the frontend's
	 * hand-written mirror claimed `number`, the backend claimed `string`, and the
	 * two met only through an `as unknown as` cast. Declared honestly so the two
	 * sides finally agree.
	 */
	created_at: number
}

export class ChatbotRepository {
	constructor(private readonly db: DatabaseHandle) {}

	async saveConversation(input: SaveConversationInput): Promise<void> {
		await this.db.insert(chatbotMessagesTable).values({
			user_id: input.userId,
			user_message: input.userMessage,
			bot_response: input.botResponse,
			context: input.context ?? {},
			created_at: input.timestamp,
		})

		logger.debug({ userId: input.userId }, "Conversation saved")
	}

	async getChatHistory(
		userId: string,
		limit: number,
	): Promise<ChatbotHistoryRow[]> {
		// Newest-first, then reversed — same shape as the Prisma query it
		// replaces. The reverse is load-bearing: the UI renders oldest-to-newest,
		// so selecting ascending and reversing would keep the OLDEST `limit` rows
		// instead of the newest.
		const rows = await this.db
			.select()
			.from(chatbotMessagesTable)
			.where(eq(chatbotMessagesTable.user_id, userId))
			.orderBy(desc(chatbotMessagesTable.created_at))
			.limit(limit)

		logger.debug({ userId, count: rows.length }, "Chat history fetched")
		return rows.reverse() as unknown as ChatbotHistoryRow[]
	}

	async clearChatHistory(userId: string): Promise<void> {
		// Prisma's `deleteMany` returned `{count}`; Drizzle's `delete` returns the
		// rows it removed, so the count is taken from the returning clause.
		const deleted = await this.db
			.delete(chatbotMessagesTable)
			.where(eq(chatbotMessagesTable.user_id, userId))
			.returning({ id: chatbotMessagesTable.id })

		logger.info({ userId, deletedRows: deleted.length }, "Chat history cleared")
	}
}
