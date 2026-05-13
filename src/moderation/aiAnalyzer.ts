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
  status: "clean" | "warn" | "flagged";
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
      const status = parsed.status === "flagged" ? "flagged" : parsed.status === "warn" ? "warn" : "clean";
      const flags = Array.isArray(parsed.flags) ? parsed.flags.map(String) : [];
      const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
      const analysis = typeof parsed.analysis === "string" ? parsed.analysis : content;
      return { status, flags, score, analysis };
    } catch {
      // Fall through to text-only parsing.
    }
  }

  return {
    status: /flagged|bahaya|berisiko|toxic|hate|harassment|violence|sexual|self-harm|illegal|scam|hacking/i.test(content) ? "flagged" : /warn|profanity|oot|tone|sopan/i.test(content) ? "warn" : "clean",
    flags: [],
    score: 0,
    analysis: content.trim() || "Tidak ada analisis dari LLM.",
  };
}

async function runLLMAnalysis(texts: string[]): Promise<{ results: LLMAnalysis[]; raw: unknown }> {
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
            content: `Kamu moderator Discord komunitas. Analisis setiap pesan dengan 3 kategori:
- CLEAN: Pesan normal, tidak melanggar aturan
- WARN: Melanggar aturan minor (profanity ringan, OOT, tone kurang sopan) - butuh peringatan tapi tidak dihapus
- FLAGGED: Melanggar aturan berat (NSFW, ilegal, hacking, scam, harassment, violence, SARA, gore, spam) - butuh review moderator untuk penghapusan

Aturan komunitas:
1. Jaga Sikap: Bahasa sopan, hormati semua tanpa diskriminasi
2. Hindari Konflik: Jangan pancing keributan, selesaikan masalah pribadi
3. Sesuai Channel: Jangan OOT (Out of Topic)
4. Konten Eksplisit Dilarang: NSFW, ilegal, pornografi, kekerasan, SARA
5. Tidak Ada Ruang LGBT: Komunitas tidak toleran terhadap LGBT
6. Jaga Privasi: Jangan sebarkan info pribadi
7. Profil Sopan: Username, foto, tag harus pantas
8. Jangan Spam/Scam: Hoaks, phishing, spam, promosi, judi, referral dilarang
9. Pertanyaan Jelas: Langsung ke inti, jangan "Boleh nanya?"
10. Diskusi Berkualitas: Jawaban relevan, akurat, tidak menyesatkan

Balas JSON array dengan schema: [{"status":"clean|warn|flagged","flags":["..."],"score":0..1,"analysis":"ringkasan Bahasa Indonesia + alasan + aksi disarankan"}]
Satu JSON object per pesan dalam array.`,
          },
          {
            role: "user",
            content: `Analisis ${texts.length} pesan berikut:\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
          },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(config.AI_ANALYSIS_TIMEOUT_MS),
    }),
    { retries: 2, logger },
  ) as ChatCompletionResponse;

  const content = response.choices?.[0]?.message?.content?.trim() || "";

  // Extract JSON array from response
  const jsonStart = content.indexOf("[");
  const jsonEnd = content.lastIndexOf("]");
  let results: LLMAnalysis[] = [];

  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(content.substring(jsonStart, jsonEnd + 1));
      if (Array.isArray(parsed)) {
        results = parsed.map((item: any) => {
          const status = item.status === "flagged" ? "flagged" : item.status === "warn" ? "warn" : "clean";
          return {
            status,
            flags: Array.isArray(item.flags) ? item.flags.map(String) : [],
            score: Math.max(0, Math.min(1, Number(item.score) || 0)),
            analysis: typeof item.analysis === "string" ? item.analysis : content,
          };
        });
      }
    } catch {
      // Fall through to individual parsing
    }
  }

  // If batch parsing failed, parse as individual responses
  if (results.length === 0) {
    results = texts.map(() => parseLLMAnalysis(content));
  }

  return { results, raw: response };
}

async function analyzeAndStoreBatch(db: SqliteDatabase, messages: MessageRecord[]): Promise<void> {
  if (messages.length === 0) return;

  const texts = messages.map(getAnalysisText).filter((t) => t.length > 0);
  if (texts.length === 0) return;

  activeRequests++;
  try {
    const { results, raw } = await runLLMAnalysis(texts);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const result = results[i] || parseLLMAnalysis("");

      const row = updateMessageAIAnalysis(db, message.id, {
        status: result.status as "pending" | "clean" | "warn" | "flagged" | "error",
        flags: JSON.stringify(result.flags),
        score: result.score,
        raw: JSON.stringify(raw),
        analysis: result.analysis,
        analyzedAt: Date.now(),
        error: null,
      });
      if (row) (globalThis as any).broadcastMessageAnalyzed?.(row);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    for (const message of messages) {
      const row = updateMessageAIAnalysis(db, message.id, {
        status: "error",
        flags: null,
        score: null,
        raw: null,
        analysis: null,
        analyzedAt: Date.now(),
        error: errorMsg,
      });
      if (row) (globalThis as any).broadcastMessageAnalyzed?.(row);
    }
    logger.warn({ count: messages.length, error }, "AI batch analysis failed");
  } finally {
    activeRequests--;
  }
}

async function drainQueue(db: SqliteDatabase): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const BATCH_SIZE = 5;

    while (queuedMessageIds.size > 0) {
      // Wait if at max concurrent requests
      while (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Collect batch of messages
      const batch: MessageRecord[] = [];
      for (const messageId of queuedMessageIds) {
        if (batch.length >= BATCH_SIZE) break;
        queuedMessageIds.delete(messageId);
        const message = getMessageById(db, messageId);
        if (message) batch.push(message);
      }

      if (batch.length > 0) {
        await analyzeAndStoreBatch(db, batch);
      }
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
