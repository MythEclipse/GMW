import { config } from "../config.ts";
import { createChildLogger } from "../logger.ts";
import { retryWithBackoff } from "../retry.ts";
import type { AnalysisResult, AttachmentRecord, MessageRecord } from "./types";

const log = createChildLogger("llmModerationClient");

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

function parseFirstJsonObject(content: string): unknown {
  for (
    let start = content.indexOf("{");
    start !== -1;
    start = content.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < content.length; index++) {
      const char = content[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = inString;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === "{") depth++;
      if (char === "}") depth--;

      if (depth === 0) {
        return JSON.parse(content.slice(start, index + 1));
      }
    }
  }

  throw new Error("No JSON object found in response body");
}

/**
 * Helper to extract a JSON object from a potentially conversational or markdown-wrapped string.
 * It first scans for markdown json code blocks, then falls back to trying all start/end brace pairs from largest to smallest.
 */
export function extractJson(content: string): any {
  // 1. Try to find markdown json code blocks: ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  const matches = content.matchAll(codeBlockRegex);
  for (const match of matches) {
    const codeContent = match[1].trim();
    try {
      const parsed = JSON.parse(codeContent);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (e) {
      // Continue to next code block
    }
  }

  // 2. If no code blocks parse successfully, try scanning for {...} pairs
  const openBraces: number[] = [];
  const closeBraces: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{") openBraces.push(i);
    if (content[i] === "}") closeBraces.push(i);
  }

  // Try pairs from largest span to smallest
  for (const start of openBraces) {
    for (let j = closeBraces.length - 1; j >= 0; j--) {
      const end = closeBraces[j];
      if (end > start) {
        const candidate = content.substring(start, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object") {
            return parsed;
          }
        } catch (e) {
          // ignore and try next
        }
      }
    }
  }

  throw new Error("No JSON object found in response");
}

/**
 * Parses LLM moderation response and validates against target IDs.
 * Extracts JSON from surrounding text, validates structure, and transforms to AnalysisResult[].
 * Scans from first '{' and attempts JSON.parse at each candidate closing brace.
 */
export function parseModerationResponse(
  content: string,
  targetIds: string[],
): AnalysisResult[] {
  // Extract and parse JSON object
  let parsed = extractJson(content);

  // If parsed is a direct array, wrap it in a results object to handle LLM variations
  if (Array.isArray(parsed)) {
    parsed = { results: parsed };
  } else if (parsed && typeof parsed === "object" && !("results" in parsed)) {
    // Handle single result object (has message_id or status)
    if ("message_id" in parsed || "status" in parsed) {
      const msgId = (parsed as any).message_id || (parsed as any).id;
      parsed = {
        results: [
          {
            message_id: msgId,
            status: (parsed as any).status || "clean",
            flags: (parsed as any).flags || [],
            score:
              (parsed as any).score !== undefined ? (parsed as any).score : 0.1,
            analysis: (parsed as any).analysis || "",
          },
        ],
      };
    } else {
      // Look for any array property (result, data, messages, moderation, etc.)
      const arrayKey = Object.keys(parsed).find((key) =>
        Array.isArray((parsed as any)[key]),
      );
      if (arrayKey) {
        parsed.results = (parsed as any)[arrayKey];
      }
    }
  }

  // Validate structure
  if (!parsed || typeof parsed !== "object" || !("results" in parsed)) {
    throw new Error("Response missing 'results' array");
  }

  const response = parsed as RawModerationResponse;
  if (!Array.isArray(response.results)) {
    throw new Error("'results' must be an array");
  }

  // Track which target IDs were found
  const foundIds = new Set<string>();
  const targetIdSet = new Set(targetIds);

  // Parse and validate each result
  const results: (AnalysisResult | null)[] = response.results.map(
    (result, index) => {
      const { message_id, status, flags, score, analysis } = result;

      // Validate message_id exists and is in target list
      if (!message_id) {
        throw new Error("Result missing 'message_id'");
      }

      let finalId = String(message_id).trim();
      // Remove wrapping double quotes if any (common in some LLM outputs)
      if (finalId.startsWith('"') && finalId.endsWith('"')) {
        finalId = finalId.slice(1, -1).trim();
      }
      if (finalId.startsWith("'") && finalId.endsWith("'")) {
        finalId = finalId.slice(1, -1).trim();
      }
      if (finalId.startsWith("[") && finalId.endsWith("]")) {
        finalId = finalId.slice(1, -1).trim();
      }

      // Advanced Precision Loss & Alignment Fix
      if (!targetIdSet.has(finalId)) {
        const isSnowflake = (id: string) =>
          /^\d{15,22}$/.test(id) || id.includes("e+");

        // 1. If there's only one target, map it directly if both are Snowflake-like
        if (
          targetIds.length === 1 &&
          isSnowflake(finalId) &&
          isSnowflake(targetIds[0])
        ) {
          log.warn(
            { roundedId: finalId, matchedId: targetIds[0] },
            "Mapped single target ID directly to handle precision loss",
          );
          finalId = targetIds[0];
        } else {
          // 2. Try matching by long prefix similarity (e.g. 12+ digits)
          let cleanLlmId = finalId;
          if (finalId.includes("e+")) {
            // Convert scientific notation back to string of digits if possible
            try {
              cleanLlmId = BigInt(Number(finalId)).toString();
            } catch (_) {}
          }

          let bestMatch: string | null = null;
          let maxCommonPrefixLen = 0;

          for (const targetId of targetIds) {
            let commonLen = 0;
            const minLen = Math.min(targetId.length, cleanLlmId.length);
            for (let i = 0; i < minLen; i++) {
              if (targetId[i] === cleanLlmId[i]) {
                commonLen++;
              } else {
                break;
              }
            }
            if (commonLen >= 12 && commonLen > maxCommonPrefixLen) {
              maxCommonPrefixLen = commonLen;
              bestMatch = targetId;
            }
          }

          if (bestMatch) {
            log.warn(
              {
                roundedId: finalId,
                cleanLlmId,
                matchedId: bestMatch,
                commonLength: maxCommonPrefixLen,
              },
              "Fixed precision loss in message ID using prefix similarity",
            );
            finalId = bestMatch;
          } else if (
            response.results.length === targetIds.length &&
            targetIds[index] &&
            isSnowflake(finalId) &&
            isSnowflake(targetIds[index])
          ) {
            // 3. Fallback: if the number of results matches the number of targets,
            // map them 1:1 chronologically (by index) only if they are Snowflake-like
            log.warn(
              { roundedId: finalId, index, matchedId: targetIds[index] },
              "Aligned message ID using chronological index fallback",
            );
            finalId = targetIds[index];
          }
        }
      }

      if (!targetIdSet.has(finalId)) {
        throw new Error(
          `Unknown message_id: ${finalId} (original: ${message_id})`,
        );
      }

      if (foundIds.has(finalId)) {
        log.warn({ duplicateId: finalId }, "Duplicate message_id in response");
        throw new Error(`Duplicate message_id: ${finalId}`);
      }

      foundIds.add(finalId);

      // Validate status
      const validStatuses = ["clean", "warn", "flagged"] as const;
      if (!validStatuses.includes(status as (typeof validStatuses)[number])) {
        throw new Error(
          `Invalid status: ${status}. Must be one of: ${validStatuses.join(", ")}`,
        );
      }

      // Validate score: reject null/undefined/non-finite before coercion
      if (score === null || score === undefined) {
        throw new Error("Invalid score: must not be null or undefined");
      }
      let numScore = Number(score);
      if (!Number.isFinite(numScore)) {
        throw new Error(`Invalid score: ${score}. Must be a finite number`);
      }
      numScore = Math.max(0, Math.min(1, numScore));

      // Coerce flags to string array
      let flagsArray: string[] = [];
      if (Array.isArray(flags)) {
        flagsArray = flags.map((f) => String(f));
      } else if (flags) {
        flagsArray = [String(flags)];
      }

      // Fallback analysis
      const analysisStr = analysis ? String(analysis) : "";

      return {
        messageId: finalId,
        status: status as "clean" | "warn" | "flagged",
        flags: flagsArray,
        score: numScore,
        analysis: analysisStr,
      };
    },
  );

  const filteredResults = results.filter(
    (r): r is AnalysisResult => r !== null,
  );

  // Check that all target IDs were found
  const missingIds = targetIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    log.warn(
      { missingIds, foundCount: foundIds.size, totalCount: targetIds.length },
      "Some target IDs missing in response - marking as incomplete",
    );
    // Add clean results for missing IDs instead of failing the batch
    for (const missingId of missingIds) {
      filteredResults.push({
        messageId: missingId,
        status: "clean",
        flags: [],
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

  const messagesText = targets
    .map((msg) => `[${msg.id}] ${msg.username}: ${msg.content}`)
    .join("\n");

  const systemPrompt = `You are a content moderation assistant. Analyze messages for policy violations.

For each message, respond with a JSON object containing a "results" array.
CRITICAL: You MUST return the "message_id" EXACTLY as provided in the input, and it MUST be wrapped in double quotes as a STRING. Do not treat IDs as numbers.

Each result must have:
- message_id: the message ID (STRING, exactly as provided)
- status: "clean", "warn", or "flagged"
- flags: array of violation flags (e.g., ["spam", "hate_speech"])
- score: confidence score from 0 to 1
- analysis: brief explanation

Do not include reasoning, analysis steps, markdown, prose, XML tags, or comments.
Return ONLY valid JSON, no other text.`;

  const userPrompt = `Context: ${contextText}

Messages to analyze:
${messagesText}`;

  // Check for image attachments to support multimodal analysis
  const targetIdSet = new Set(targets.map((t) => t.id));
  const getAttachmentImageUrl = (att: AttachmentRecord): string | null => {
    if (att.uploaded_url) return att.uploaded_url;
    if (targetIdSet.has(att.message_id)) return att.discord_url;
    return null;
  };
  const imageAttachments = (attachments || [])
    .filter(
      (att) => getAttachmentImageUrl(att) && att.type.startsWith("image/"),
    )
    .sort((a, b) => {
      const aIsTarget = targetIdSet.has(a.message_id) ? 1 : 0;
      const bIsTarget = targetIdSet.has(b.message_id) ? 1 : 0;
      if (aIsTarget !== bIsTarget) {
        return bIsTarget - aIsTarget; // Target messages first
      }
      return b.created_at - a.created_at; // Most recent first
    })
    .slice(0, 8); // Cap at 8 to prevent LLM API limits (e.g. Nemotron/Omni models 8-image limit)

  let messageContent:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  if (imageAttachments.length > 0) {
    const imageParts = await Promise.all(
      imageAttachments.map(async (att) => {
        try {
          const urlToUse = getAttachmentImageUrl(att);
          if (!urlToUse) return [];
          log.info(
            { attachmentId: att.id, url: urlToUse },
            "Downloading attachment for base64 encoding",
          );
          const res = await fetch(urlToUse);
          if (!res.ok) {
            log.warn(
              { attachmentId: att.id, status: res.status },
              "Failed to fetch attachment image",
            );
            return [];
          }

          const buffer = await res.arrayBuffer();
          const base64Str = Buffer.from(buffer).toString("base64");
          const dataUrl = `data:${att.type};base64,${base64Str}`;

          return [
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
              },
            },
            {
              type: "text",
              text: `\n[Image Attachment for Message ID: ${att.message_id}, Filename: ${att.filename}]`,
            },
          ];
        } catch (err) {
          log.warn(
            {
              attachmentId: att.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error base64 encoding attachment",
          );
          return [];
        }
      }),
    );

    messageContent = [
      ...imageParts.flat(),
      {
        type: "text",
        text: userPrompt,
      },
    ];
  } else {
    messageContent = userPrompt;
  }

  const result = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        config.AI_ANALYSIS_TIMEOUT_MS,
      );

      try {
        const response = await fetch(
          `${config.AI_LLM_BASE_URL}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.AI_LLM_API_KEY}`,
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: config.AI_LLM_MODEL,
              messages: [
                {
                  role: "system",
                  content: systemPrompt,
                },
                {
                  role: "user",
                  content: messageContent,
                },
              ],
              temperature: 0,
              top_p: 1,
              max_tokens: 8192,
              response_format: { type: "json_object" },
              chat_template_kwargs: { enable_thinking: false },
            }),
          },
        );
        // Read the response body once (either text() or json()), then reuse it.
        let rawBody: string | undefined = undefined;
        if (typeof response.text === "function") {
          try {
            rawBody = await response.text();
          } catch {
            rawBody = undefined;
          }
        } else if (typeof response.json === "function") {
          try {
            const j = await response.json();
            rawBody = JSON.stringify(j);
          } catch {
            rawBody = undefined;
          }
        }

        if (!response.ok) {
          throw new Error(
            `LLM API error ${response.status}: ${rawBody ?? "(no body)"}`,
          );
        }

        if (!rawBody) {
          throw new Error("Empty LLM response");
        }

        try {
          return JSON.parse(rawBody);
        } catch {
          return parseFirstJsonObject(rawBody);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    },
    {
      retries: 3,
      minTimeout: 1000,
      maxTimeout: 10000,
      logger: log,
    },
  );

  // Extract content from response
  if (!result.choices || !Array.isArray(result.choices) || !result.choices[0]) {
    throw new Error("Invalid LLM response structure");
  }

  const content = result.choices[0].message?.content;
  if (!content) {
    throw new Error("No content in LLM response");
  }

  // Parse and validate
  let parsed: AnalysisResult[];
  try {
    parsed = parseModerationResponse(content, targetIds);
  } catch (parseError) {
    const errorMsg =
      parseError instanceof Error ? parseError.message : String(parseError);
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
      "Robust Fallback: Failed to parse moderation response. Defaulting all targets to clean.",
    );
    parsed = targetIds.map((id) => ({
      messageId: id,
      status: "clean",
      flags: [],
      score: 0.1,
      analysis: `Parsing failed: ${errorMsg}. Defaulted to clean.`,
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
