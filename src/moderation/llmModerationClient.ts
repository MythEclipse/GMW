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

/**
 * Parses LLM moderation response and validates against target IDs.
 * Extracts JSON from surrounding text, validates structure, and transforms to AnalysisResult[].
 * Scans from first '{' and attempts JSON.parse at each candidate closing brace.
 */
function salvageMalformedModerationResponse(
  content: string,
  targetIds: string[],
): AnalysisResult[] | null {
  const idMatches = content.match(/\d{10,22}/g) ?? [];
  let matchedId: string | null = null;

  for (const targetId of targetIds) {
    if (content.includes(targetId)) {
      matchedId = targetId;
      break;
    }
  }

  if (!matchedId) {
    for (const candidate of idMatches) {
      matchedId =
        targetIds.find(
          (targetId) =>
            targetId.startsWith(candidate) || candidate.startsWith(targetId),
        ) ?? null;
      if (matchedId) break;
    }
  }

  if (!matchedId) return null;

  const statusMatch = content.match(/"status"\s*:\s*"(clean|warn|flagged)"/);
  const scoreMatch = content.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/);
  const analysisMatch = content.match(/"analysis"\s*:\s*"([^"]*)"/);

  return [
    {
      messageId: matchedId,
      status: (statusMatch?.[1] as "clean" | "warn" | "flagged") ?? "clean",
      flags: [],
      score: scoreMatch ? Math.max(0, Math.min(1, Number(scoreMatch[1]))) : 0,
      analysis:
        analysisMatch?.[1] ?? "Recovered from malformed moderation response",
    },
  ];
}

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

  const moderationPrompt = `You are a content moderation assistant. Analyze messages for policy violations.

Context:
${contextText}

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

Do not include reasoning, analysis steps, markdown, prose, XML tags, or comments.
Return ONLY valid JSON, no other text.`;

  // Check for image attachments to support multimodal analysis
  const targetIdSet = new Set(targets.map((t) => t.id));
  const getAttachmentImageUrl = (att: AttachmentRecord): string | null => {
    if (att.uploaded_url) return att.uploaded_url;
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

  type MessageContent =
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;

  let imageParts: Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
  }> = [];
  if (imageAttachments.length > 0) {
    imageParts = (
      await Promise.all(
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
      )
    ).flat();
  }

  let lastParseError: string | null = null;
  let lastInvalidContent: string | null = null;
  const buildMessageContent = (): MessageContent => {
    const correctionPrompt = lastParseError
      ? `${moderationPrompt}\n\nPrevious response failed validation. Error: ${lastParseError}\nInvalid response preview:\n${lastInvalidContent?.slice(0, 1000) ?? "<empty>"}\n\nRetry with corrected output. Return ONLY one valid JSON object matching the required schema.`
      : moderationPrompt;

    if (imageParts.length > 0) {
      return [
        ...imageParts,
        {
          type: "text",
          text: correctionPrompt,
        },
      ];
    }

    return correctionPrompt;
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
          max_tokens: 65536,
          response_format: { type: "json_object" },
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
    const salvaged = salvageMalformedModerationResponse(content, targetIds);
    if (salvaged) {
      log.warn(
        {
          error: errorMsg,
          contentLength: content.length,
          contentPreview: content.substring(0, 500),
          targetIds,
          recoveredIds: salvaged.map((result) => result.messageId),
          model: config.AI_LLM_MODEL,
          timestamp: new Date().toISOString(),
        },
        "Recovered moderation response from malformed JSON",
      );
      const recoveredIds = new Set(salvaged.map((result) => result.messageId));
      parsed = [
        ...salvaged,
        ...targetIds
          .filter((id) => !recoveredIds.has(id))
          .map((id) => ({
            messageId: id,
            status: "error" as const,
            flags: ["analysis_incomplete"],
            score: 0,
            analysis: "Analysis incomplete - malformed LLM response",
          })),
      ];
    } else {
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
