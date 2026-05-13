import { config } from "../config";
import { createChildLogger } from "../logger";
import type { SqliteDatabase } from "../muxer-queue";
import { retryWithBackoff } from "../retry";
import { getMessageById, getPendingAIAnalysisMessages, updateMessageAIAnalysis } from "./messageStore";
import type { MessageRecord } from "./types";

const logger = createChildLogger("ai-analyzer");
const queuedMessageIds = new Set<string>();
let isProcessing = false;
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 1;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface LLMAnalysis {
  status: "clean" | "flagged";
  flags: string[];
  score: number;
  analysis: string;
}

function getAnalysisText(message: MessageRecord): string {
  return (message.edited_content || message.content || "").trim();
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.AI_ANALYSIS_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();

    if (!response.ok) {
      const message = text.includes("{")
        ? JSON.stringify(JSON.parse(text.substring(text.indexOf("{"))))
        : text;
      throw new Error(`AI request failed (${response.status}): ${message}`);
    }

    // Handle streaming response: extract JSON from response text
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
      } catch {
        // Fall through to parse full text
      }
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function parseLLMAnalysis(content: string): LLMAnalysis {
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      const status = parsed.status === "flagged" ? "flagged" : "clean";
      const flags = Array.isArray(parsed.flags) ? parsed.flags.map(String) : [];
      const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
      const analysis = typeof parsed.analysis === "string" ? parsed.analysis : content;
      return { status, flags, score, analysis };
    } catch {
      // Fall through to text-only parsing.
    }
  }

  return {
    status: /flagged|bahaya|berisiko|toxic|hate|harassment|violence|sexual|self-harm/i.test(content) ? "flagged" : "clean",
    flags: [],
    score: 0,
    analysis: content.trim() || "Tidak ada analisis dari LLM.",
  };
}

async function runLLMAnalysis(text: string): Promise<{ result: LLMAnalysis; raw: unknown }> {
  const response = await retryWithBackoff(
    () => fetchJson(`${config.AI_LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.AI_LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.AI_LLM_MODEL,
        messages: [
          {
            role: "system",
            content: "Kamu analis moderation Discord. Nilai pesan untuk toxic, harassment, hate, violence, sexual, self-harm, spam, scam, atau unsafe content. Balas JSON valid saja dengan schema: {\"status\":\"clean|flagged\",\"flags\":[\"...\"],\"score\":0..1,\"analysis\":\"ringkasan singkat Bahasa Indonesia + alasan + aksi disarankan\"}.",
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.2,
      }),
    }),
    { retries: 2, logger },
  ) as ChatCompletionResponse;

  const content = response.choices?.[0]?.message?.content?.trim() || "";
  return { result: parseLLMAnalysis(content), raw: response };
}

async function analyzeAndStore(db: SqliteDatabase, message: MessageRecord): Promise<void> {
  const text = getAnalysisText(message);
  if (!config.AI_ANALYSIS_ENABLED || text.length === 0) return;

  activeRequests++;
  try {
    const { result, raw } = await runLLMAnalysis(text);
    const row = updateMessageAIAnalysis(db, message.id, {
      status: result.status,
      flags: JSON.stringify(result.flags),
      score: result.score,
      raw: JSON.stringify(raw),
      analysis: result.analysis,
      analyzedAt: Date.now(),
      error: null,
    });
    if (row) (globalThis as any).broadcastMessageAnalyzed?.(row);
  } catch (error) {
    const row = updateMessageAIAnalysis(db, message.id, {
      status: "error",
      flags: null,
      score: null,
      raw: null,
      analysis: null,
      analyzedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    if (row) (globalThis as any).broadcastMessageAnalyzed?.(row);
    logger.warn({ messageId: message.id, error }, "AI analysis failed");
  } finally {
    activeRequests--;
  }
}

async function drainQueue(db: SqliteDatabase): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (queuedMessageIds.size > 0) {
      // Wait if at max concurrent requests
      while (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const messageId = queuedMessageIds.values().next().value as string | undefined;
      if (!messageId) break;
      queuedMessageIds.delete(messageId);
      const message = getMessageById(db, messageId);
      if (message) await analyzeAndStore(db, message);
    }
  } finally {
    isProcessing = false;
  }
}

export function queueMessageAnalysis(db: SqliteDatabase, messageId: string): void {
  if (!config.AI_ANALYSIS_ENABLED) return;
  logger.debug({ messageId }, "Queueing AI analysis");
  queuedMessageIds.add(messageId);
  setImmediate(() => {
    drainQueue(db).catch((error) => logger.error({ error }, "AI analysis queue failed"));
  });
}

export function startPendingAIAnalysisWorker(db: SqliteDatabase): void {
  if (!config.AI_ANALYSIS_ENABLED) {
    logger.info("AI analysis disabled");
    return;
  }

  logger.info("AI analysis worker started");
  setInterval(() => {
    if (isProcessing) return;
    const pendingMessages = getPendingAIAnalysisMessages(db, 3);
    if (pendingMessages.length === 0) return;
    logger.info({ count: pendingMessages.length }, "Queueing pending AI analysis messages");
    for (const message of pendingMessages) {
      queuedMessageIds.add(message.id);
    }
    drainQueue(db).catch((error) => logger.error({ error }, "Pending AI analysis worker failed"));
  }, 15000);
}
