import { Worker } from "node:worker_threads";
import { config } from "../config";
import { createChildLogger } from "../logger";
import {
  getMessageById,
  getPendingConversationKeys,
  getPendingMessagesByConversation,
} from "./messageStore";
import type {
  AnalysisQueueStatus,
  MessageRecord,
  ModerationBroadcaster,
} from "./types";

const logger = createChildLogger("ai-analyzer");

type ModerationGlobal = typeof globalThis & {
  moderationBroadcaster?: ModerationBroadcaster;
};

function getModerationBroadcaster(): ModerationBroadcaster | undefined {
  return (globalThis as ModerationGlobal).moderationBroadcaster;
}

// Debounce state per conversation key
const conversationDebounceTimers = new Map<string, NodeJS.Timeout>();
// Track conversations currently being processed
const conversationProcessing = new Set<string>();
// Track conversations in error cooldown (failed recently)
const conversationErrorCooldown = new Map<string, number>();

let activeRequests = 0;
let lastError: string | null = null;

interface AnalysisWorkerResponse {
  ok: boolean;
  conversationKey: string;
  rows: MessageRecord[];
  error?: string;
}

/**
 * Gets the conversation key for a message (thread_id or channel_id)
 */
export function getConversationKey(message: MessageRecord): string {
  return message.thread_id || message.channel_id;
}

/**
 * Picks a batch of messages within token budget
 */
export function pickBatchWithinBudget(
  messages: MessageRecord[],
  maxTokens: number,
  tokensPerMessage: number,
): MessageRecord[] {
  const batch: MessageRecord[] = [];
  let usedTokens = 0;

  for (const msg of messages) {
    // Estimate tokens based on actual content length
    const content = msg.edited_content ?? msg.content;
    const contentTokens = Math.ceil(content.length / 4);
    const msgTokens = contentTokens + tokensPerMessage;

    if (usedTokens + msgTokens <= maxTokens) {
      batch.push(msg);
      usedTokens += msgTokens;
    }
  }

  return batch;
}

/**
 * Processes a batch of messages for a conversation
 */
async function processBatch(
  conversationKey: string,
  messages: MessageRecord[],
): Promise<void> {
  if (messages.length === 0) return;

  activeRequests++;
  conversationProcessing.add(conversationKey);
  try {
    const result = await runAnalysisInWorker(conversationKey, messages);

    for (const row of result.rows) {
      getModerationBroadcaster()?.messageAnalyzed(row);
    }

    if (!result.ok) {
      lastError = result.error ?? "Analysis worker failed";
      conversationErrorCooldown.set(
        conversationKey,
        Date.now() + config.AI_ANALYSIS_ERROR_COOLDOWN_MS,
      );
      logger.error(
        {
          conversationKey,
          error: lastError,
          messageCount: messages.length,
          messageIds: messages.map((m) => m.id),
          cooldownUntil: new Date(
            Date.now() + config.AI_ANALYSIS_ERROR_COOLDOWN_MS,
          ).toISOString(),
          timestamp: new Date().toISOString(),
        },
        "Batch analysis failed, will retry after cooldown",
      );
      return;
    }

    conversationErrorCooldown.delete(conversationKey);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    conversationErrorCooldown.set(
      conversationKey,
      Date.now() + config.AI_ANALYSIS_ERROR_COOLDOWN_MS,
    );
    logger.error(
      {
        conversationKey,
        error: lastError,
        stack: errorStack,
        messageCount: messages.length,
        messageIds: messages.map((m) => m.id),
        cooldownUntil: new Date(
          Date.now() + config.AI_ANALYSIS_ERROR_COOLDOWN_MS,
        ).toISOString(),
        timestamp: new Date().toISOString(),
      },
      "Analysis worker failed, will retry after cooldown",
    );
  } finally {
    activeRequests--;
    conversationProcessing.delete(conversationKey);
  }
}

async function runAnalysisInWorker(
  conversationKey: string,
  messages: MessageRecord[],
): Promise<AnalysisWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./aiAnalysisWorker.ts", import.meta.url),
      { execArgv: process.execArgv },
    );

    worker.once("message", (response: AnalysisWorkerResponse) => {
      worker.terminate().catch((error) => {
        logger.warn({ error }, "Failed to terminate analysis worker");
      });
      resolve(response);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Analysis worker exited with code ${code}`));
      }
    });
    worker.postMessage({ conversationKey, messages });
  });
}

/**
 * Debounced analysis trigger for a conversation
 */
function scheduleConversationAnalysis(conversationKey: string): void {
  // Skip if already processing
  if (conversationProcessing.has(conversationKey)) {
    return;
  }

  // Skip if in error cooldown
  const cooldownUntil = conversationErrorCooldown.get(conversationKey);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return;
  }

  // Clear existing timer
  const existingTimer = conversationDebounceTimers.get(conversationKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Always use shorter debounce for immediate processing (no concurrency limit)
  const debounceTime = config.AI_ANALYSIS_DEBOUNCE_MS;

  // Set new debounced timer
  const timer = setTimeout(async () => {
    conversationDebounceTimers.delete(conversationKey);

    // Get pending messages for this conversation
    const messages = await getPendingMessagesByConversation(
      conversationKey,
      config.AI_ANALYSIS_MAX_BATCH_SIZE,
    );

    if (messages.length > 0) {
      await processBatch(conversationKey, messages);
    }
  }, debounceTime);

  conversationDebounceTimers.set(conversationKey, timer);
}

/**
 * Queues a message for analysis (debounced by conversation)
 */
export async function queueMessageAnalysis(messageId: string): Promise<void> {
  if (!config.AI_ANALYSIS_ENABLED) return;

  try {
    // Look up the message to get its conversation key
    const message = await getMessageById(messageId);
    if (!message) {
      logger.warn({ messageId }, "Message not found for analysis queue");
      return;
    }

    // Schedule its conversation for analysis
    const conversationKey = getConversationKey(message);
    queueConversationAnalysis(conversationKey);
  } catch (error) {
    logger.error(
      {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to queue message for analysis",
    );
  }
}

/**
 * Queues a conversation for analysis (debounced)
 */
export function queueConversationAnalysis(conversationKey: string): void {
  if (!config.AI_ANALYSIS_ENABLED) return;

  // Schedule debounced analysis
  scheduleConversationAnalysis(conversationKey);
}

/**
 * Gets current analysis queue status
 */
export function getAnalysisQueueStatus(): AnalysisQueueStatus {
  return {
    queuedConversations: conversationDebounceTimers.size,
    activeRequests,
    lastError,
  };
}

/**
 * Starts the pending AI analysis recovery worker
 */
export function startPendingAIAnalysisWorker(): void {
  if (!config.AI_ANALYSIS_ENABLED) return;

  setInterval(async () => {
    try {
      // Get pending conversation keys
      const conversationKeys = await getPendingConversationKeys(100);

      for (const key of conversationKeys) {
        // Skip if already scheduled
        if (conversationDebounceTimers.has(key)) {
          continue;
        }

        // Skip if currently processing
        if (conversationProcessing.has(key)) {
          continue;
        }

        // Skip if in error cooldown
        const cooldownUntil = conversationErrorCooldown.get(key);
        if (cooldownUntil && Date.now() < cooldownUntil) {
          continue;
        }

        scheduleConversationAnalysis(key);
      }
    } catch (error) {
      logger.error({ error }, "Pending AI analysis recovery worker failed");
    }
  }, config.AI_ANALYSIS_RECOVERY_INTERVAL_MS);
}
