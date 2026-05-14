import { config } from "../config";
import { createChildLogger } from "../logger";
import type { SqliteDatabase } from "../muxer-queue";
import { retryWithBackoff } from "../retry";
import {
  getMessageById,
  getPendingAIAnalysisMessages,
  updateMessageAIAnalysis,
} from "./messageStore";
import type { MessageRecord } from "./types";

const logger = createChildLogger("ai-analyzer");
const queuedMessageIds = new Set<string>();
let isProcessing = false;
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 1;
const MAX_AI_REQUEST_TOKENS = 12_000;
const AI_PROMPT_TOKEN_RESERVE = 3_000;
const MAX_AI_BATCH_MESSAGES = 80;

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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatMessageForAnalysis(
  message: MessageRecord,
  index: number,
): string {
  const text = getAnalysisText(message);
  const time = new Date(message.created_at).toISOString();
  return `${index + 1}. id=${message.id} time=${time} user=${message.username}: ${text}`;
}

function estimateMessageTokens(message: MessageRecord): number {
  return estimateTokens(formatMessageForAnalysis(message, 0)) + 16;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.AI_ANALYSIS_TIMEOUT_MS,
  );

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
      const status =
        parsed.status === "flagged"
          ? "flagged"
          : parsed.status === "warn"
            ? "warn"
            : "clean";
      const flags = Array.isArray(parsed.flags) ? parsed.flags.map(String) : [];
      const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
      const analysis =
        typeof parsed.analysis === "string" ? parsed.analysis : content;
      return { status, flags, score, analysis };
    } catch {
      // Fall through to text-only parsing.
    }
  }

  return {
    status:
      /flagged|bahaya|berisiko|toxic|hate|harassment|violence|sexual|self-harm|illegal|scam|hacking/i.test(
        content,
      )
        ? "flagged"
        : /warn|provokasi|hinaan|menyerang/i.test(content)
          ? "warn"
          : "clean",
    flags: [],
    score: 0,
    analysis: content.trim() || "Tidak ada analisis dari LLM.",
  };
}

async function runLLMAnalysis(
  messages: MessageRecord[],
): Promise<{ results: LLMAnalysis[]; raw: unknown }> {
  const response = (await retryWithBackoff(
    () =>
      fetchJson(`${config.AI_LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.AI_LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.AI_LLM_MODEL,
          messages: [
            {
              role: "system",
              content: `Kamu moderator Discord komunitas. Analisis setiap pesan dengan 3 kategori:
- CLEAN: Pesan normal, tidak melanggar aturan
- WARN: Melanggar aturan minor yang menarget orang lain (tone menyerang, hinaan ringan, konflik kecil) - butuh peringatan tapi tidak dihapus
- FLAGGED: Melanggar aturan berat (NSFW, ilegal, hacking, scam, harassment, violence, SARA, gore, spam, promosi judi) - butuh review moderator untuk penghapusan

ATURAN KOMUNITAS LENGKAP:

1. JAGA SIKAP DAN HORMATI SESAMA
   - Gunakan bahasa yang sopan dan menghormati semua anggota
   - Tanpa memandang latar belakang, usia, gender, atau pandangan
   - Dilarang keras: pelecehan, rasisme, seksisme, diskriminasi

2. HINDARI KONFLIK
   - Dilarang memancing keributan atau drama
   - Jika ada masalah personal, selesaikan secara pribadi
   - Jangan melibatkan anggota lain di channel umum

3. KONTEN EKSPLISIT DILARANG
   - Dilarang keras: NSFW, ilegal, pornografi, kekerasan (gore), SARA
   - Tidak ada tempat untuk penyimpangan atau LGBT
   - Tidak ada promosi aktivitas atau ideologi LGBT

4. JAGA PRIVASI
   - Dilarang menyebarkan informasi pribadi milik anggota lain tanpa izin

5. PROFIL YANG SOPAN
   - Username, foto profil, dan server tag harus pantas
   - Jangan gunakan unsur ofensif atau vulgar

6. DILARANG SPAM DAN PENIPUAN
   - Dilarang: hoaks, link berbahaya (phishing/scam), spam
   - Dilarang: promosi, judi, link referral

7. DISKUSI BERKUALITAS
   - Berikan jawaban yang relevan, akurat, dan tidak menyesatkan
   - Di channel "Area Serius", pertahankan standar tinggi

KONTEKS KOMUNITAS:
- Ini grup bercanda/santai, jadi slang, candaan ringan, kata kasar ringan tanpa target, pesan pendek seperti "." atau "P", dan pertanyaan tidak jelas tetap CLEAN
- Jangan beri WARN hanya karena pesan singkat, informal, ambigu, low-quality, atau kurang konteks
- Pahami alur pembahasan antar pesan: pesan yang sendiri terlihat normal bisa WARN/FLAGGED jika dalam konteks percakapan sedang memancing konflik, menormalisasi pelanggaran, atau melanjutkan provokasi
- Jangan menghukum orang yang sedang menasehati, menjelaskan bahaya, mengutip, atau menolak tindakan buruk; nilai maksud dan konteksnya
- WARN hanya jika ada orang/kelompok yang diserang, dihina, diprovokasi, atau konflik mulai dipancing

PENENTUAN STATUS:
- WARN jika: hinaan ringan yang menarget orang/kelompok, provokasi konflik kecil, username/profil kurang pantas
- FLAGGED jika: profanity berat, harassment, threats, violence, illegal activity, hacking, scam, NSFW, SARA, gore, spam, judi, LGBT content

Balas JSON array dengan schema: [{"status":"clean|warn|flagged","flags":["..."],"score":0..1,"analysis":"ringkasan Bahasa Indonesia + alasan + aksi disarankan"}]
Satu JSON object per pesan dalam array.`,
            },
            {
              role: "user",
              content: `Analisis ${messages.length} pesan berikut sebagai satu alur percakapan. Tetap kembalikan satu hasil per pesan dengan urutan yang sama:\n${messages.map(formatMessageForAnalysis).join("\n")}`,
            },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(config.AI_ANALYSIS_TIMEOUT_MS),
      }),
    { retries: 2, logger },
  )) as ChatCompletionResponse;

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
          const status =
            item.status === "flagged"
              ? "flagged"
              : item.status === "warn"
                ? "warn"
                : "clean";
          return {
            status,
            flags: Array.isArray(item.flags) ? item.flags.map(String) : [],
            score: Math.max(0, Math.min(1, Number(item.score) || 0)),
            analysis:
              typeof item.analysis === "string" ? item.analysis : content,
          };
        });
      }
    } catch {
      // Fall through to individual parsing
    }
  }

  // If batch parsing failed, parse as individual responses
  if (results.length === 0) {
    results = messages.map(() => parseLLMAnalysis(content));
  }

  return { results, raw: response };
}

async function analyzeAndStoreBatch(
  messages: MessageRecord[],
): Promise<void> {
  if (messages.length === 0) return;

  const analyzableMessages = messages.filter(
    (message) => getAnalysisText(message).length > 0,
  );
  if (analyzableMessages.length === 0) return;

  activeRequests++;
  try {
    const { results, raw } = await runLLMAnalysis(analyzableMessages);

    for (let i = 0; i < analyzableMessages.length; i++) {
      const message = analyzableMessages[i];
      const result = results[i] || parseLLMAnalysis("");

      const row = await updateMessageAIAnalysis(message.id, {
        status: result.status as
          | "pending"
          | "clean"
          | "warn"
          | "flagged"
          | "error",
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
    if (analyzableMessages.length > 1) {
      const midpoint = Math.ceil(analyzableMessages.length / 2);
      logger.warn(
        {
          count: analyzableMessages.length,
          nextBatchSizes: [midpoint, analyzableMessages.length - midpoint],
          error,
        },
        "AI batch failed, splitting into smaller batches",
      );
      await analyzeAndStoreBatch(analyzableMessages.slice(0, midpoint));
      await analyzeAndStoreBatch(analyzableMessages.slice(midpoint));
      return;
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    for (const message of analyzableMessages) {
      const row = await updateMessageAIAnalysis(message.id, {
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

async function drainQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    const batchTokenLimit = MAX_AI_REQUEST_TOKENS - AI_PROMPT_TOKEN_RESERVE;

    while (queuedMessageIds.size > 0) {
      while (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const batch: MessageRecord[] = [];
      let tokenEstimate = 0;
      for (const messageId of Array.from(queuedMessageIds)) {
        const message = await getMessageById(messageId);
        queuedMessageIds.delete(messageId);
        if (!message) continue;

        const messageTokens = estimateMessageTokens(message);
        if (
          batch.length > 0 &&
          (batch.length >= MAX_AI_BATCH_MESSAGES ||
            tokenEstimate + messageTokens > batchTokenLimit)
        ) {
          queuedMessageIds.add(messageId);
          break;
        }

        batch.push(message);
        tokenEstimate += messageTokens;
      }

      if (batch.length > 0) {
        logger.info(
          { count: batch.length, tokenEstimate },
          "Processing AI analysis batch",
        );
        await analyzeAndStoreBatch(batch);
      }
    }
  } finally {
    isProcessing = false;
  }
}

export function queueMessageAnalysis(
  messageId: string,
): void {
  if (!config.AI_ANALYSIS_ENABLED) return;
  logger.debug({ messageId }, "Queueing AI analysis");
  queuedMessageIds.add(messageId);
  setImmediate(() => {
    drainQueue().catch((error) =>
      logger.error({ error }, "AI analysis queue failed"),
    );
  });
}

export function startPendingAIAnalysisWorker(): void {
  if (!config.AI_ANALYSIS_ENABLED) {
    logger.info("AI analysis disabled");
    return;
  }

  logger.info("AI analysis worker started");
  setInterval(async () => {
    if (isProcessing) return;
    const pendingMessages = await getPendingAIAnalysisMessages(500);
    if (pendingMessages.length === 0) return;
    logger.info(
      { count: pendingMessages.length },
      "Queueing pending AI analysis messages",
    );
    for (const message of pendingMessages) {
      queuedMessageIds.add(message.id);
    }
    drainQueue().catch((error) =>
      logger.error({ error }, "Pending AI analysis worker failed"),
    );
  }, 15000);
}
