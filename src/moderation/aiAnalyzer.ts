import { config } from "../config";
import { createChildLogger } from "../logger";
import type { SqliteDatabase } from "../muxer-queue";
import { retryWithBackoff } from "../retry";
import { getMessageById, updateMessageAIAnalysis } from "./messageStore";
import type { MessageRecord } from "./types";

const logger = createChildLogger("ai-analyzer");
const queuedMessageIds = new Set<string>();
let isProcessing = false;

interface ModerationResult {
  flagged: boolean;
  flags: string[];
  score: number;
  raw: unknown;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function getAnalysisText(message: MessageRecord): string {
  return (message.edited_content || message.content || "").trim();
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.AI_ANALYSIS_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body === "object" && body && "error" in body
        ? JSON.stringify(body)
        : response.statusText;
      throw new Error(`AI request failed (${response.status}): ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function runModeration(text: string): Promise<ModerationResult> {
  const response = await retryWithBackoff(
    () => fetchJson(`${config.OPENAI_MODERATION_BASE_URL}/moderations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.OPENAI_MODERATION_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.OPENAI_MODERATION_MODEL,
        input: text,
      }),
    }),
    { retries: 2, logger },
  ) as any;

  const result = response.results?.[0] || {};
  const categories = result.categories || {};
  const categoryScores = result.category_scores || {};
  const flags = Object.entries(categories)
    .filter(([, flagged]) => Boolean(flagged))
    .map(([name]) => name);
  const score = Math.max(0, ...Object.values(categoryScores).map((value) => Number(value) || 0));

  return {
    flagged: Boolean(result.flagged) || flags.length > 0,
    flags,
    score,
    raw: response,
  };
}

async function runLLMAnalysis(text: string, moderation: ModerationResult): Promise<string> {
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
            content: "Kamu analis moderation Discord. Jawab singkat dalam Bahasa Indonesia: ringkasan risiko, alasan, dan aksi yang disarankan. Jangan mengulang pesan mentah secara panjang.",
          },
          {
            role: "user",
            content: JSON.stringify({
              message: text,
              moderationFlagged: moderation.flagged,
              moderationFlags: moderation.flags,
              moderationScore: moderation.score,
            }),
          },
        ],
        temperature: 0.2,
      }),
    }),
    { retries: 2, logger },
  ) as ChatCompletionResponse;

  return response.choices?.[0]?.message?.content?.trim() || "Tidak ada analisis dari LLM.";
}

async function analyzeAndStore(db: SqliteDatabase, message: MessageRecord): Promise<void> {
  const text = getAnalysisText(message);
  if (!config.AI_ANALYSIS_ENABLED || text.length === 0) return;

  try {
    const moderation = await runModeration(text);
    const analysis = await runLLMAnalysis(text, moderation);
    const row = updateMessageAIAnalysis(db, message.id, {
      status: moderation.flagged ? "flagged" : "clean",
      flags: JSON.stringify(moderation.flags),
      score: moderation.score,
      raw: JSON.stringify(moderation.raw),
      analysis,
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
  }
}

async function drainQueue(db: SqliteDatabase): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (queuedMessageIds.size > 0) {
      const [messageId] = queuedMessageIds;
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
  queuedMessageIds.add(messageId);
  setImmediate(() => {
    drainQueue(db).catch((error) => logger.error({ error }, "AI analysis queue failed"));
  });
}
