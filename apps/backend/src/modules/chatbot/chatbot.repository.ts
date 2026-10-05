import { desc, eq } from "drizzle-orm";
import { getDatabase } from "@/shared/database/drizzle";
import { chatbotMessagesTable } from "@/shared/database/schema";
import { createChildLogger } from "@/shared/logger/index.js";

const logger = createChildLogger("chatbot.repository");

export interface ChatbotContext {
  messageCount?: number;
  activeParticipants?: number;
  lastActivity?: string;
  topicsDiscussed?: string[];
  guildId?: string;
  channelId?: string;
}

export interface SaveConversationInput {
  userId: string;
  userMessage: string;
  botResponse: string;
  context?: ChatbotContext;
  timestamp: Date;
}

export interface ChatbotHistoryRow {
  id: string;
  user_id: string;
  user_message: string;
  bot_response: string;
  context: ChatbotContext | null;
  created_at: string;
}

export class ChatbotRepository {
  async saveConversation(input: SaveConversationInput): Promise<void> {
    const db = getDatabase();

    await db.insert(chatbotMessagesTable).values({
      user_id: input.userId,
      user_message: input.userMessage,
      bot_response: input.botResponse,
      context: input.context ?? {},
      created_at: input.timestamp,
    });

    logger.debug({ userId: input.userId }, "Conversation saved");
  }

  async getChatHistory(
    userId: string,
    limit: number,
  ): Promise<ChatbotHistoryRow[]> {
    const db = getDatabase();

    // Newest-first, then reversed — same shape as the Prisma query it
    // replaces. The reverse is load-bearing: the UI renders oldest-to-newest,
    // so selecting ascending and reversing would keep the OLDEST `limit` rows
    // instead of the newest.
    const rows = await db
      .select()
      .from(chatbotMessagesTable)
      .where(eq(chatbotMessagesTable.user_id, userId))
      .orderBy(desc(chatbotMessagesTable.created_at))
      .limit(limit);

    logger.debug({ userId, count: rows.length }, "Chat history fetched");
    return rows.reverse() as unknown as ChatbotHistoryRow[];
  }

  async clearChatHistory(userId: string): Promise<void> {
    const db = getDatabase();

    // Prisma's `deleteMany` returned `{count}`; Drizzle's `delete` returns the
    // rows it removed, so the count is taken from the returning clause.
    const deleted = await db
      .delete(chatbotMessagesTable)
      .where(eq(chatbotMessagesTable.user_id, userId))
      .returning({ id: chatbotMessagesTable.id });

    logger.info(
      { userId, deletedRows: deleted.length },
      "Chat history cleared",
    );
  }
}

export const chatbotRepository = new ChatbotRepository();
