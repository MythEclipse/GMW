import { config } from "../config";
import { createChildLogger } from "../logger";
import { retryWithBackoff } from "../retry";
import type { AnalysisResult, MessageRecord } from "./types";

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
 * Parses LLM moderation response and validates against target IDs.
 * Extracts JSON from surrounding text, validates structure, and transforms to AnalysisResult[].
 * Scans from first '{' and attempts JSON.parse at each candidate closing brace.
 */
export function parseModerationResponse(
  content: string,
  targetIds: string[],
): AnalysisResult[] {
  // Find first opening brace and last closing brace
  const startIdx = content.indexOf("{");
  const endIdx = content.lastIndexOf("}");

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error("No JSON object found in response");
  }

  // Attempt to parse the largest possible JSON object
  let parsed: unknown;
  const candidate = content.substring(startIdx, endIdx + 1);

  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    // If full substring fails, try scanning backwards from the last }
    let lastError: Error =
      error instanceof Error ? error : new Error(String(error));

    for (let i = endIdx - 1; i > startIdx; i--) {
      if (content[i] === "}") {
        try {
          parsed = JSON.parse(content.substring(startIdx, i + 1));
          break;
        } catch (innerError) {
          lastError =
            innerError instanceof Error
              ? innerError
              : new Error(String(innerError));
          continue;
        }
      }
    }

    if (!parsed) {
      throw new Error(`Failed to parse JSON: ${lastError.message}`);
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
  const results: (AnalysisResult | null)[] = response.results.map((result) => {
    const { message_id, status, flags, score, analysis } = result;

    // Validate message_id exists and is in target list
    if (!message_id) {
      throw new Error("Result missing 'message_id'");
    }

    let finalId = String(message_id);

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
      log.warn(
        { duplicateId: finalId },
        "Skipping duplicate/rounded message_id",
      );
      return null;
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
  }

  return filteredResults;
}

interface ModerationInput {
  targets: MessageRecord[];
  contextText: string;
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
  const { targets, contextText } = input;

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
                  content: prompt,
                },
              ],
              temperature: 0.3,
            }),
          },
        );

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`LLM API error ${response.status}: ${text}`);
        }

        const bodyText = await response.text();
        try {
          return JSON.parse(bodyText);
        } catch (e) {
          // Handle cases where the API provider returns trailing garbage
          const start = bodyText.indexOf("{");
          const end = bodyText.lastIndexOf("}");
          if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(bodyText.substring(start, end + 1));
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
