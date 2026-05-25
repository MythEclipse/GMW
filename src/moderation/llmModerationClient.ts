import OpenAI from "openai";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";
import { retryWithBackoff } from "../retry.js";
import type {
  AnalysisResult,
  AttachmentRecord,
  MessageRecord,
} from "./types.js";

const log = createChildLogger("llmModerationClient");
const openai = new OpenAI({
  apiKey: config.AI_LLM_API_KEY,
  baseURL: config.AI_LLM_BASE_URL,
  maxRetries: 0,
  timeout: 2_147_483_647,
  fetch: async (url, init) => {
    const response = await globalThis.fetch(url, init);
    const body =
      typeof response.text === "function"
        ? await response.text()
        : JSON.stringify(await response.json());

    let normalizedBody = body;
    if (response.ok !== false) {
      try {
        JSON.parse(body);
      } catch (error) {
        log.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            status: response.status ?? 200,
            bodyLength: body.length,
            body,
          },
          "LLM provider returned malformed JSON response body",
        );
        normalizedBody = JSON.stringify(extractJson(body));
      }
    }

    const headers = new Headers(response.headers ?? undefined);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");

    return new Response(normalizedBody, {
      status: response.status ?? 200,
      headers,
    });
  },
});

interface RawModerationResult {
  message_id: string;
  status: string;
  flags: unknown;
  score: number;
  analysis: string;
}

interface RawModerationResponse {
  results: RawModerationResult[];
}

/**
 * Helper to extract JSON from a potentially conversational or markdown-wrapped string.
 */
export function extractJson(content: string): any {
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  const matches = content.matchAll(codeBlockRegex);
  for (const match of matches) {
    const codeContent = match[1].trim();
    try {
      const parsed = JSON.parse(codeContent);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (_) {}
  }

  for (let start = 0; start < content.length; start++) {
    const firstChar = content[start];
    if (firstChar !== "{" && firstChar !== "[") continue;

    const stack = [firstChar];
    let inString = false;
    let escaped = false;

    for (let i = start + 1; i < content.length; i++) {
      const char = content[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      const last = stack[stack.length - 1];
      if ((char === "}" && last === "{") || (char === "]" && last === "[")) {
        stack.pop();
        if (stack.length === 0) {
          const candidate = content.slice(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object") {
              return parsed;
            }
          } catch (_) {}
          break;
        }
      }
    }
  }

  throw new Error("No JSON object found in response");
}



export function parseModerationResponse(
  content: string,
  targetIds: string[],
): AnalysisResult[] {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    parsed = extractJson(content);
  }

  if (Array.isArray(parsed)) {
    parsed = { results: parsed };
  } else if (parsed && typeof parsed === "object" && !("results" in parsed)) {
    const arrayKey = Object.keys(parsed).find((key) =>
      Array.isArray((parsed as any)[key]),
    );
    if (arrayKey) {
      parsed.results = (parsed as any)[arrayKey];
    } else {
      parsed = { results: [parsed] };
    }
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.results)) {
    throw new Error("Response missing 'results' array");
  }

  const response = parsed as RawModerationResponse;
  const foundIds = new Set<string>();
  const targetIdSet = new Set(targetIds);

  const results: (AnalysisResult | null)[] = response.results.map(
    (result, index) => {
      const { message_id, status, flags, score, analysis } = result;

      if (!message_id) {
        throw new Error("Result missing 'message_id'");
      }

      const finalId = String(message_id).trim();

      if (!targetIdSet.has(finalId)) {
        log.warn(
          { unknownId: finalId, originalId: message_id, targetIds },
          "Skipping moderation result for non-target message_id",
        );
        return null;
      }

      if (foundIds.has(finalId)) {
        log.warn({ duplicateId: finalId }, "Duplicate message_id in response");
        throw new Error(`Duplicate message_id: ${finalId}`);
      }

      foundIds.add(finalId);

      const validStatuses = ["clean", "warn", "flagged"] as const;
      const safeStatus = validStatuses.includes(status as any) ? status : "clean";

      let numScore = Number(score);
      if (!Number.isFinite(numScore)) {
        numScore = 0;
      }
      numScore = Math.max(0, Math.min(1, numScore));

      let flagsArray: string[] = [];
      if (Array.isArray(flags)) {
        flagsArray = flags.map((f) => String(f));
      } else if (flags) {
        flagsArray = [String(flags)];
      }

      const analysisStr = analysis ? String(analysis) : "";

      return {
        messageId: finalId,
        status: safeStatus as "clean" | "warn" | "flagged",
        flags: flagsArray,
        score: numScore,
        analysis: analysisStr,
      };
    },
  );

  const filteredResults = results.filter(
    (r): r is AnalysisResult => r !== null,
  );

  const missingIds = targetIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    log.warn(
      { missingIds, foundCount: foundIds.size, totalCount: targetIds.length },
      "Some target IDs missing in response - marking as incomplete",
    );
    for (const missingId of missingIds) {
      filteredResults.push({
        messageId: missingId,
        status: "error",
        flags: ["analysis_incomplete"],
        score: 0,
        analysis: "Analysis incomplete - LLM did not process this message",
      });
    }
  }

  return filteredResults;
}

interface ModerationInput {
  targets: MessageRecord[];
  contextText: string;
  attachments?: AttachmentRecord[];
}

interface ModerationOutput {
  results: AnalysisResult[];
  raw: unknown;
}

/**
 * Sniff the first bytes of a buffer to determine if it is a supported image
 * format. Returns the canonical MIME type string on success, or null if the
 * bytes are not a recognizable image.
 *
 * Supported probes (in order):
 *   - JPEG:  FF D8 FF
 *   - PNG:   89 50 4E 47 0D 0A 1A 0A
 *   - GIF:   47 49 46 38 (GIF8)
 *   - WebP:  52 49 46 46 ?? ?? ?? ?? 57 45 42 50 (RIFF....WEBP)
 *   - AVIF / HEIF: 4-byte big-endian size + 66 74 79 70 (ftyp ISO base-media box)
 */
function sniffImageMimeType(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "image/gif";
  }

  // WebP: RIFF????WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }

  // AVIF / HEIF: ISO base media file format — ftyp box at offset 4
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (brand.startsWith("avif") || brand.startsWith("avis")) {
      return "image/avif";
    }
    if (
      brand.startsWith("mif1") ||
      brand.startsWith("heic") ||
      brand.startsWith("heis")
    ) {
      return "image/heic";
    }
  }

  return null;
}

/**
 * Runs LLM-based moderation analysis on messages.
 * POSTs to AI_LLM_BASE_URL with auth bearer token.
 */
export async function runModerationAnalysis(
  input: ModerationInput,
): Promise<ModerationOutput> {
  const { targets, contextText, attachments } = input;

  if (!targets.length) {
    throw new Error("No targets provided for analysis");
  }

  const targetIds = targets.map((t) => t.id);

  // Build a lookup: message_id → list of resolved base64 image parts
  type RawImagePart = { type: "image_url"; image_url: { url: string } };
  type MessageImageMap = Map<string, RawImagePart[]>;

  // Resolve and download image attachments, grouped by message_id.
  // Only images whose message_id appears in the full attachment list are kept;
  // target messages get priority in the 8-image global cap.
  const getAttachmentImageUrl = (att: AttachmentRecord): string | null =>
    att.uploaded_url ?? null;

  const targetIdSet = new Set(targets.map((t) => t.id));

  const candidateAttachments = (attachments ?? [])
    .filter((att) => getAttachmentImageUrl(att) && att.type.startsWith("image/"))
    .sort((a, b) => {
      // Target-message attachments always come first so they consume the cap first
      const aIsTarget = targetIdSet.has(a.message_id) ? 1 : 0;
      const bIsTarget = targetIdSet.has(b.message_id) ? 1 : 0;
      if (aIsTarget !== bIsTarget) return bIsTarget - aIsTarget;
      // Within the same priority tier, newest first
      return b.created_at - a.created_at;
    })
    .slice(0, 8); // Hard cap — some vision APIs (Nemotron, Omni) reject >8 images

  const messageImageMap: MessageImageMap = new Map();

  await Promise.all(
    candidateAttachments.map(async (att) => {
      const urlToUse = getAttachmentImageUrl(att);
      if (!urlToUse) return;

      try {
        log.info(
          { attachmentId: att.id, messageId: att.message_id, url: urlToUse },
          "Downloading attachment for base64 encoding",
        );
        const res = await fetch(urlToUse);
        if (!res.ok) {
          log.warn(
            { attachmentId: att.id, status: res.status, url: urlToUse },
            "Failed to fetch attachment image — non-2xx status",
          );
          return;
        }

        const contentLength = Number(res.headers.get("content-length") || 0);
        if (contentLength > 10 * 1024 * 1024) {
          log.warn({ attachmentId: att.id, contentLength }, "Attachment too large, skipping");
          return;
        }

        const imageBytes = Buffer.from(await res.arrayBuffer());
        const sniffedMime = sniffImageMimeType(imageBytes);
        if (!sniffedMime) {
          log.warn(
            {
              attachmentId: att.id,
              url: urlToUse,
              dbType: att.type,
              bytesLength: imageBytes.length,
              headerHex: imageBytes.subarray(0, 16).toString("hex"),
            },
            "Skipping attachment: downloaded bytes are not a recognised image format",
          );
          return;
        }

        const dataUrl = `data:${sniffedMime};base64,${imageBytes.toString("base64")}`;
        const part: RawImagePart = { type: "image_url", image_url: { url: dataUrl } };

        const existing = messageImageMap.get(att.message_id) ?? [];
        existing.push(part);
        messageImageMap.set(att.message_id, existing);
      } catch (err) {
        log.warn(
          {
            attachmentId: att.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "Error base64 encoding attachment",
        );
      }
    }),
  );

  const hasImages = messageImageMap.size > 0;

  // -------------------------------------------------------------------------
  // System prompt — Indonesian-first, English as secondary language.
  //
  // Core design decisions:
  //  • Explicitly names the server as a Discord community whose primary
  //    communication language is Indonesian; English is secondary.
  //  • Instructs the model to understand Indonesian slang, abbreviations,
  //    and culturally specific harmful patterns (SARA, hoaks, dll).
  //  • When images are present, instructs the model to treat each image as
  //    an integral part of the message that precedes it — not as standalone
  //    content — so text + image are evaluated together.
  //  • Strict JSON-only output, no markdown or prose.
  // -------------------------------------------------------------------------
  const buildSystemPrompt = (correction?: {
    error: string;
    preview: string;
  }): string => {
    const imageInstructions = hasImages
      ? `
## Instruksi Analisis Gambar
Beberapa pesan menyertakan lampiran gambar. Setiap gambar muncul TEPAT SETELAH baris teks pesan yang memilikinya.
Gambar dan teks pesan harus dianalisis sebagai SATU KESATUAN — evaluasilah konten teks DAN gambar secara bersamaan untuk membentuk kesimpulan final.
Jangan pisahkan penilaian gambar dari konteks teks pesannya.
Jika gambar mengandung teks (meme, screenshot), baca dan pertimbangkan teks tersebut sebagai bagian dari konten pesan.
`
      : "";

    const base = `Kamu adalah asisten moderasi konten untuk server Discord berbahasa Indonesia.
Bahasa utama komunitas ini adalah BAHASA INDONESIA. Bahasa Inggris adalah bahasa sekunder.

## Konteks Server
Ini adalah server Discord komunitas Indonesia. Kamu harus memahami:
- Bahasa gaul/slang Indonesia: "anjay", "wkwk", "gws", "gaskeun", "santuy", "njir", "baka", dll.
- Singkatan umum: "gw", "lo", "emg", "kyk", "tdk", "krn", "jgn", dll.
- Konteks budaya lokal: SARA (Suku, Agama, Ras, Antar-golongan), hoaks, ujaran kebencian berbasis konteks Indonesia.
- Perbedaan antara humor/banter biasa vs konten yang benar-benar melanggar.
- Kalimat ambigu dalam bahasa Indonesia harus ditafsirkan dengan charitable intent kecuali ada indikator kuat sebaliknya.
${imageInstructions}
## Konteks Percakapan
${contextText}

## Format Output
Balas HANYA dengan satu objek JSON valid. Tanpa markdown, tanpa prose, tanpa komentar, tanpa XML.
Struktur wajib:
{
  "results": [
    {
      "message_id": "<ID string PERSIS seperti di input>",
      "status": "clean" | "warn" | "flagged",
      "flags": [<string array, kosong jika clean>],
      "score": <float 0.0–1.0>,
      "analysis": "<penjelasan singkat dalam Bahasa Indonesia, maks 2 kalimat>"
    }
  ]
}

Kriteria status:
- "clean": tidak ada pelanggaran yang terdeteksi
- "warn": konten berpotensi melanggar atau memerlukan perhatian moderator
- "flagged": pelanggaran jelas terdeteksi

Flag yang valid: spam, hate_speech, sara, hoaks, harassment, sexual_content, violence, self_harm, doxxing, scam, misinformation, nsfw_image, gore_image, illegal_content

CRITICAL: "message_id" HARUS berupa STRING (dibungkus tanda kutip ganda). Jangan perlakukan ID sebagai angka — ini snowflake Discord yang bisa kehilangan presisi jika diparse sebagai number.`;

    if (correction) {
      return `${base}\n\nRESPON SEBELUMNYA GAGAL VALIDASI.\nError: ${correction.error}\nPreview respons tidak valid:\n${correction.preview}\n\nCoba lagi dengan output JSON yang benar sesuai skema di atas.`;
    }
    return base;
  };

  // -------------------------------------------------------------------------
  // Build the user-turn content.
  //
  // When images exist, we build an interleaved multipart array:
  //   [system prompt text] → for each target: [msg text part] → [image(s) for that msg]
  //
  // This interleaving is the critical fix: it ensures the vision model
  // processes each image in direct proximity to its owning message text,
  // rather than receiving all images as a disconnected prologue.
  // -------------------------------------------------------------------------
  type ContentPart = { type: "text"; text: string } | RawImagePart;

  let lastParseError: string | null = null;
  let lastInvalidContent: string | null = null;

  const buildMessageContent = (): string | ContentPart[] => {
    const correction = lastParseError
      ? { error: lastParseError, preview: lastInvalidContent?.slice(0, 800) ?? "<empty>" }
      : undefined;

    const systemText = buildSystemPrompt(correction);

    if (!hasImages) {
      // Pure-text path: format all targets in a single block
      const messagesBlock = targets
        .map((msg) => {
          const content = msg.edited_content ?? msg.content;
          return `[target] id=${msg.id} user=${msg.username}: ${content}`;
        })
        .join("\n");

      return `${systemText}\n\n## Pesan yang Dianalisis\n${messagesBlock}`;
    }

    // Multimodal path: interleave text + images per message
    const parts: ContentPart[] = [
      { type: "text", text: `${systemText}\n\n## Pesan yang Dianalisis (dengan lampiran gambar)\n` },
    ];

    for (const msg of targets) {
      const content = msg.edited_content ?? msg.content;
      const msgText = `[target] id=${msg.id} user=${msg.username}: ${content}`;
      parts.push({ type: "text", text: msgText });

      // Immediately follow the message text with its images
      const imgs = messageImageMap.get(msg.id);
      if (imgs && imgs.length > 0) {
        for (const img of imgs) {
          parts.push(img);
        }
        // Anchor label after the image(s) so the model's attention window
        // links this image block back to the message ID above it
        parts.push({
          type: "text",
          text: `[gambar di atas adalah lampiran dari pesan id=${msg.id}]`,
        });
      }
    }

    return parts;
  };

  let parsed: AnalysisResult[];
  let result: OpenAI.Chat.Completions.ChatCompletion | null = null;
  try {
    const analysis = await retryWithBackoff(
      async () => {
        const completion = await openai.chat.completions.create({
          model: config.AI_LLM_MODEL,
          messages: [
            {
              role: "user",
              content: buildMessageContent(),
            },
          ],
          temperature: 0.2,
          top_p: 0.95,
          max_tokens: 16384,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "moderation",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        message_id: { type: "string" },
                        status: { type: "string", enum: ["clean", "warn", "flagged"] },
                        flags: { type: "array", items: { type: "string" } },
                        score: { type: "number" },
                        analysis: { type: "string" }
                      },
                      required: ["message_id", "status", "flags", "score", "analysis"],
                      additionalProperties: false
                    }
                  }
                },
                required: ["results"],
                additionalProperties: false
              }
            }
          },
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
          reasoning_budget: 0,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

        if (
          !completion.choices ||
          !Array.isArray(completion.choices) ||
          !completion.choices[0]
        ) {
          throw new Error("Invalid LLM response structure");
        }

        const content = completion.choices[0].message?.content;
        if (!content) {
          throw new Error("No content in LLM response");
        }

        try {
          return {
            parsed: parseModerationResponse(content, targetIds),
            result: completion,
          };
        } catch (parseError) {
          lastParseError =
            parseError instanceof Error
              ? parseError.message
              : String(parseError);
          lastInvalidContent = content;
          log.warn(
            {
              error: lastParseError,
              contentLength: content.length,
              contentPreview: content.substring(0, 1000),
              fullContent: content,
              targetIds,
              model: config.AI_LLM_MODEL,
            },
            "Failed to parse moderation response from LLM",
          );
          throw parseError;
        }
      },
      {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 10000,
        logger: log,
      },
    );
    parsed = analysis.parsed;
    result = analysis.result;
  } catch (parseError) {
    if (!lastInvalidContent) {
      throw parseError;
    }

    const errorMsg =
      parseError instanceof Error ? parseError.message : String(parseError);
    const content: string = lastInvalidContent;
    
    log.error(
      {
        error: errorMsg,
        contentLength: content.length,
        contentPreview: content.substring(0, 500),
        fullContent: content,
        targetIds,
        model: config.AI_LLM_MODEL,
        timestamp: new Date().toISOString(),
      },
      "Robust Fallback: Failed to parse moderation response. Marking all targets as analysis errors.",
    );
    parsed = targetIds.map((id) => ({
      messageId: id,
      status: "error",
      flags: ["analysis_parse_failed"],
      score: 0,
      analysis: `Parsing failed: ${errorMsg}.`,
    }));
  }

  log.info(
    {
      targetCount: targets.length,
      resultCount: parsed.length,
    },
    "Moderation analysis complete",
  );

  return {
    results: parsed,
    raw: result,
  };
}
