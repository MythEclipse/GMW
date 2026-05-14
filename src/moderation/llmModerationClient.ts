import { createChildLogger } from "../logger";
import { retryWithBackoff } from "../retry";
import { config } from "../config";
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
 */
export function parseModerationResponse(
  content: string,
  targetIds: string[],
): AnalysisResult[] {
  // Extract JSON object from surrounding text
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON object found in response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  const results: AnalysisResult[] = response.results.map((result) => {
    const { message_id, status, flags, score, analysis } = result;

    // Validate message_id exists and is in target list
    if (!message_id) {
      throw new Error("Result missing 'message_id'");
    }

    if (!targetIdSet.has(message_id)) {
      throw new Error(`Unknown message_id: ${message_id}`);
    }

    foundIds.add(message_id);

    // Validate status
    const validStatuses = ["clean", "warn", "flagged"] as const;
    if (!validStatuses.includes(status as (typeof validStatuses)[number])) {
      throw new Error(
        `Invalid status: ${status}. Must be one of: ${validStatuses.join(", ")}`,
      );
    }

    // Validate and clamp score
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
      messageId: message_id,
      status: status as "clean" | "warn" | "flagged",
      flags: flagsArray,
      score: numScore,
      analysis: analysisStr,
    };
  });

  // Check that all target IDs were found
  const missingIds = targetIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Missing target ids in response: ${missingIds.join(", ")}`);
  }

  return results;
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

For each message, respond with a JSON object containing a "results" array. Each result must have:
- message_id: the message ID
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

        return response.json();
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
