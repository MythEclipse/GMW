/**
 * The only place in the service that talks to the model.
 *
 * v1's `llmClient.ts` was 446 lines carrying four responsibilities: a per-lane
 * concurrency semaphore, an internal retry loop, provider stream-fallback
 * heuristics, and chunk-text extraction for ~6 response shapes. The worker layer
 * then added its OWN retry on top, which is how one bad sentence could produce
 * four re-requests plus sixty individual fallbacks.
 *
 * This module keeps only what the caller cannot do itself:
 *   - the wire call and its timeout
 *   - refusal / empty-response classification (a policy signal, not a fault)
 *
 * Retry and concurrency are the caller's decision, made from the durable
 * `attempts` counter. One layer, one decision.
 */

import OpenAI from "openai";
import { config } from "@/shared/config/index";
import { createChildLogger } from "@/shared/logger/index";

const log = createChildLogger("moderation/llm");

export type LlmRequest = {
  system: string;
  user: string;
  /** Per-call deadline. Must stay below the worker's lease. */
  timeoutMs: number;
};

export interface LlmGateway {
  /**
   * Recorded on `verdicts.model` and `analysis_attempts.model` so a verdict can
   * be traced to the model that produced it.
   */
  readonly modelLabel?: string;
  complete(req: LlmRequest): Promise<string>;
}

export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!config.AI_LLM_API_KEY) {
    throw new LlmUnavailableError(
      "AI_LLM_API_KEY is not set — cannot run moderation",
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: config.AI_LLM_API_KEY,
      baseURL: config.AI_LLM_BASE_URL,
      // No client-level retry. The worker's durable attempt counter owns
      // retrying; stacking two layers multiplied worst-case call count.
      maxRetries: 0,
      timeout: 60_000,
    });
  }
  return client;
}

/**
 * Covers the response shapes the streaming path can produce. Providers differ
 * in field name, so try each in turn rather than assuming OpenAI's layout.
 */
type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
    };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  message?: { content?: string | null };
  content?: string;
};

export function extractChunkText(
  chunk: StreamChunk | null | undefined,
): string {
  if (!chunk) return "";
  const choice = chunk.choices?.[0];
  return (
    choice?.delta?.content ||
    choice?.delta?.reasoning_content ||
    choice?.delta?.reasoning ||
    choice?.message?.content ||
    chunk.message?.content ||
    chunk.content ||
    ""
  );
}

export class HttpLlmGateway implements LlmGateway {
  readonly modelLabel: string;

  constructor(private readonly model: string) {
    this.modelLabel = model;
  }

  async complete(req: LlmRequest): Promise<string> {
    const c = getClient();
    const base = {
      model: this.model,
      messages: [
        { role: "system" as const, content: req.system },
        { role: "user" as const, content: req.user },
      ],
      temperature: 0.2,
      max_tokens: 8192,
      ...(config.AI_LLM_DISABLE_THINKING
        ? {
            reasoning_effort: "none" as const,
            chat_template_kwargs: { enable_thinking: false },
          }
        : {}),
    };

    let content: string | null = null;
    let refusal: string | null | undefined;

    // Streaming first: the router always answers with SSE, and a non-stream
    // request waits for the full body and can time out on a slow model.
    try {
      const stream = await c.chat.completions.create(
        {
          ...base,
          stream: true,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { timeout: req.timeoutMs },
      );
      let acc = "";
      for await (const chunk of stream as unknown as AsyncIterable<StreamChunk>) {
        acc += extractChunkText(chunk);
      }
      content = acc;
    } catch (err) {
      // Large responses occasionally get their SSE truncated mid-flight and a
      // stream retry fails identically. One non-stream attempt recovers it.
      const msg = err instanceof Error ? err.message : String(err);
      if (
        !/stream ended before producing a non-ping sse|terminated/i.test(msg)
      ) {
        throw new LlmUnavailableError(msg, err);
      }
      log.warn({ model: this.model }, "SSE truncated; retrying non-stream");
      try {
        const completion = await c.chat.completions.create(
          {
            ...base,
            stream: false,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          { timeout: req.timeoutMs },
        );
        content = completion.choices?.[0]?.message?.content ?? null;
        refusal = (
          completion.choices?.[0]?.message as { refusal?: string } | undefined
        )?.refusal;
      } catch (inner) {
        throw new LlmUnavailableError(
          inner instanceof Error ? inner.message : String(inner),
          inner,
        );
      }
    }

    if (typeof content === "string" && content.trim().length > 0)
      return content;

    // A refusal arrives as `refusal` with null content. That is the model
    // declining, which is a policy signal worth its own log line, not a
    // transport fault.
    if (refusal) {
      log.warn({ refusal, model: this.model }, "model refused the batch");
      throw new LlmUnavailableError(`model refused: ${refusal}`);
    }
    throw new LlmUnavailableError("empty completion content");
  }
}

export function createDefaultGateway(): LlmGateway {
  return new HttpLlmGateway(config.AI_LLM_MODEL);
}
