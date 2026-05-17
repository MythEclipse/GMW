import { parentPort } from "node:worker_threads";
import { initializeDatabase } from "../database/drizzle.ts";
import { buildConversationPromptMessages } from "./conversationContext.ts";
import { runModerationAnalysis } from "./llmModerationClient.ts";
import {
  getConversationContextBefore,
  updateMessageAIAnalysis,
} from "./messageStore.ts";
import type { MessageRecord } from "./types";

const MAX_CONTEXT_TOKENS = 8000;

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
      limit: 20,
    });

    const promptMessages = buildConversationPromptMessages({
      contextBefore,
      targets: messages,
      maxTokens: MAX_CONTEXT_TOKENS,
    });

    const result = await runModerationAnalysis({
      targets: messages,
      contextText: promptMessages.join("\n"),
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
    const rows: MessageRecord[] = [];

    for (const msg of messages) {
      const row = await updateMessageAIAnalysis(msg.id, {
        status: "error",
        flags: null,
        score: null,
        raw: null,
        analysis: null,
        analyzedAt: Date.now(),
        error: errorMessage,
      });
      if (row) rows.push(row);
    }

    return { ok: false, conversationKey, rows, error: errorMessage };
  }
}

parentPort?.on("message", async (request: AnalysisWorkerRequest) => {
  parentPort?.postMessage(await processAnalysisRequest(request));
});
