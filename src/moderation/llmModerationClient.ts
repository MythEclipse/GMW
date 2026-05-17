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
  const parsed = extractJson(content);

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
  const results: (AnalysisResult | null)[] = response.results.map((result) => {
    const { message_id, status, flags, score, analysis } = result;

    // Validate message_id exists and is in target list
    if (!message_id) {
      throw new Error("Result missing 'message_id'");
    }

    let finalId = String(message_id).trim();
    if (finalId.startsWith("[") && finalId.endsWith("]")) {
      finalId = finalId.slice(1, -1).trim();
    }

    // Precision loss fix: If the ID from LLM is not found,
    // try to find the closest match in targets if it looks rounded (ends in 000)
    if (!targetIdSet.has(finalId)) {
      if (finalId.endsWith("00") || finalId.includes("e+")) {
        const roundedPrefix = finalId.substring(0, 10);
        const match = targetIds.find((id) => id.startsWith(roundedPrefix));
        if (match) {
          log.warn(
            { roundedId: finalId, matchedId: match },
            "Fixed precision loss in message ID",
          );
          finalId = match;
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
  });

  const filteredResults = results.filter(
    (r): r is AnalysisResult => r !== null,
  );

  // Check that all target IDs were found
  const missingIds = targetIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    log.warn({ missingIds }, "Some target IDs missing in response");
    throw new Error(`Missing target IDs: ${missingIds.join(",")}`);
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

  // Build prompt
  const messagesText = targets
    .map((msg) => `[${msg.id}] ${msg.username}: ${msg.content}`)
    .join("\n");

  const prompt = `You are a content moderation assistant. Analyze the following messages for policy violations.

Context: ${contextText}

Messages to analyze:
${messagesText}

For each message, respond with a JSON object containing a "results" array.
CRITICAL: You MUST return the "message_id" EXACTLY as provided in the input, and it MUST be wrapped in double quotes as a STRING. Do not treat IDs as numbers.

Each result must have:
- message_id: the message ID (STRING, exactly as provided)
- status: "clean", "warn", or "flagged"
- flags: array of violation flags (e.g., ["spam", "hate_speech"])
- score: confidence score from 0 to 1
- analysis: brief explanation

Return ONLY valid JSON, no other text.`;

  // Check for image attachments to support multimodal analysis
  const targetIdSet = new Set(targets.map((t) => t.id));
  const imageAttachments = (attachments || [])
    .filter(
      (att) =>
        (att.uploaded_url || att.discord_url) && att.type.startsWith("image/"),
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
    const contentParts: Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }> = [];

    // Download and convert all images to base64 data URLs
    for (const att of imageAttachments) {
      try {
        const urlToUse = att.uploaded_url || att.discord_url;
        log.info(
          { attachmentId: att.id, url: urlToUse },
          "Downloading attachment for base64 encoding",
        );
        const res = await fetch(urlToUse);
        if (res.ok) {
          const buffer = await res.arrayBuffer();
          const base64Str = Buffer.from(buffer).toString("base64");
          const dataUrl = `data:${att.type};base64,${base64Str}`;

          contentParts.push({
            type: "image_url",
            image_url: {
              url: dataUrl,
            },
          });

          contentParts.push({
            type: "text",
            text: `\n[Image Attachment for Message ID: ${att.message_id}, Filename: ${att.filename}]`,
          });
        } else {
          log.warn(
            { attachmentId: att.id, status: res.status },
            "Failed to fetch attachment image",
          );
        }
      } catch (err) {
        log.warn(
          {
            attachmentId: att.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "Error base64 encoding attachment",
        );
      }
    }

    contentParts.push({
      type: "text",
      text: prompt,
    });

    messageContent = contentParts;
  } else {
    // If no image is present, send a transparent 1x1 dummy PNG to satisfy multimodal omni requirements
    const dummyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    messageContent = [
      {
        type: "image_url",
        image_url: {
          url: dummyPng,
        },
      },
      {
        type: "text",
        text: prompt,
      },
    ];
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
                  role: "user",
                  content: messageContent,
                },
              ],
              temperature: 0.6,
              top_p: 0.95,
              max_tokens: 65536,
              reasoning_budget: 16384,
              chat_template_kwargs: { enable_thinking: true },
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

        // Try to parse the body as JSON, with fallback to scanning for an object
        try {
          return JSON.parse(rawBody);
        } catch (e) {
          const start = rawBody.indexOf("{");
          const end = rawBody.lastIndexOf("}");
          if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(rawBody.substring(start, end + 1));
          }
          throw e;
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
  const parsed = parseModerationResponse(content, targetIds);

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
