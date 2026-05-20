import { parentPort } from "node:worker_threads";
import { config } from "../config.ts";
import { initializeDatabase } from "../database/drizzle.ts";
import { buildConversationPromptMessages } from "./conversationContext.ts";
import { runModerationAnalysis } from "./llmModerationClient.ts";
import {
  getAttachmentsForMessages,
  getConversationContextBefore,
  updateMessageAIAnalysis,
} from "./messageStore.ts";
import type { MessageRecord } from "./types";

let dbInitialized = false;

interface AnalysisWorkerRequest {
  conversationKey: string;
  messages: MessageRecord[];
}

type AnalysisWorkerResponse =
  | {
      ok: true;
      conversationKey: string;
      rows: MessageRecord[];
    }
  | {
      ok: false;
      conversationKey: string;
      rows: MessageRecord[];
      error: string;
    };

async function processAnalysisRequest({
  conversationKey,
  messages,
}: AnalysisWorkerRequest): Promise<AnalysisWorkerResponse> {
  try {
    try {
      if (!dbInitialized) {
        await initializeDatabase();
        dbInitialized = true;
      }
    } catch (dbError) {
      const msg = dbError instanceof Error ? dbError.message : String(dbError);
      return {
        ok: false,
        conversationKey,
        rows: [],
        error: `Database init failed: ${msg}`,
      };
    }

    const firstMessage = messages[0];
    if (!firstMessage) return { ok: true, conversationKey, rows: [] };

    const contextBefore = await getConversationContextBefore({
      channelId: firstMessage.channel_id,
      threadId: firstMessage.thread_id,
      beforeCreatedAt: firstMessage.created_at,
      limit: config.AI_ANALYSIS_CONTEXT_MESSAGE_LIMIT,
    });

    const promptMessages = buildConversationPromptMessages({
      contextBefore,
      targets: messages,
      maxTokens: config.AI_ANALYSIS_MAX_CONTEXT_TOKENS,
    });

    const targetIds = messages.map((m) => m.id);
    const contextIds = contextBefore.map((m) => m.id);
    const allMessageIds = [...targetIds, ...contextIds];
    const attachments = await getAttachmentsForMessages(allMessageIds);

    const result = await runModerationAnalysis({
      targets: messages,
      contextText: promptMessages.join("\n"),
      attachments,
    });

    const rows: MessageRecord[] = [];
    for (const analysisResult of result.results) {
      const row = await updateMessageAIAnalysis(analysisResult.messageId, {
        status: analysisResult.status,
        flags: JSON.stringify(analysisResult.flags),
        score: analysisResult.score,
        raw: JSON.stringify(result.raw),
        analysis: analysisResult.analysis,
        analyzedAt: Date.now(),
        error: null,
      });
      if (row) rows.push(row);
    }

    return { ok: true, conversationKey, rows };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const rows: MessageRecord[] = [];

    console.error(
      JSON.stringify({
        level: "ERROR",
        context: "aiAnalysisWorker",
        conversationKey,
        messageCount: messages.length,
        error: errorMessage,
        stack: errorStack,
        timestamp: new Date().toISOString(),
      }),
    );

    return { ok: false, conversationKey, rows, error: errorMessage };
  }
}

parentPort?.on("message", async (request: AnalysisWorkerRequest) => {
  parentPort?.postMessage(await processAnalysisRequest(request));
});
