import { config } from "../config";
import { createChildLogger } from "../logger";
import {
  getConversationContextBefore,
  getMessageById,
  getPendingConversationKeys,
  getPendingMessagesByConversation,
  updateMessageAIAnalysis,
} from "./messageStore";
import { buildConversationPromptMessages } from "./conversationContext";
import { runModerationAnalysis } from "./llmModerationClient";
import type { AnalysisQueueStatus, MessageRecord } from "./types";

const logger = createChildLogger("ai-analyzer");

// Debounce state per conversation key
const conversationDebounceTimers = new Map<string, NodeJS.Timeout>();
// Track conversations currently being processed
const conversationProcessing = new Set<string>();
// Track conversations in error cooldown (failed recently)
const conversationErrorCooldown = new Map<string, number>();

let activeRequests = 0;
let lastError: string | null = null;
const MAX_ACTIVE_REQUESTS = 1;
const DEBOUNCE_MS = 1500;
const RECOVERY_INTERVAL_MS = 15000;
const ERROR_COOLDOWN_MS = 30000;
const MAX_CONTEXT_TOKENS = 8000;
const MAX_BATCH_SIZE = 25;

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
    // Get context before the first message
    const firstMessage = messages[0];
    const contextBefore = await getConversationContextBefore({
      channelId: firstMessage.channel_id,
      threadId: firstMessage.thread_id,
      beforeCreatedAt: firstMessage.created_at,
      limit: 20,
    });

    // Build prompt with context
    const promptMessages = buildConversationPromptMessages({
      contextBefore,
      targets: messages,
      maxTokens: MAX_CONTEXT_TOKENS,
    });

    const contextText = promptMessages.join("\n");

    // Run moderation analysis
    const result = await runModerationAnalysis({
      targets: messages,
      contextText,
    });

    // Store results
    const analyzedRows: MessageRecord[] = [];
    for (const analysisResult of result.results) {
      const row = await updateMessageAIAnalysis(analysisResult.messageId, {
        status: analysisResult.status,
        flags: JSON.stringify(analysisResult.flags),
        score: analysisResult.score,
        raw: JSON.stringify(result.raw),
        analysis: analysisResult.analysis,
        analyzedAt: Date.now(),
        error: null,
      });
      if (row) {
        analyzedRows.push(row);
      }
    }

    // Broadcast analyzed messages
    for (const row of analyzedRows) {
      (globalThis as any).broadcastMessageAnalyzed?.(row);
    }

    // Clear error cooldown on success
    conversationErrorCooldown.delete(conversationKey);

    logger.info(
      { conversationKey, count: messages.length },
      "Batch analysis complete",
    );
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);

    logger.error(
      { conversationKey, error: lastError },
      "Batch analysis failed",
    );

    // Mark all messages in batch as error
    for (const msg of messages) {
      const row = await updateMessageAIAnalysis(msg.id, {
        status: "error",
        flags: null,
        score: null,
        raw: null,
        analysis: null,
        analyzedAt: Date.now(),
        error: lastError,
      });
      if (row) {
        (globalThis as any).broadcastMessageAnalyzed?.(row);
      }
    }

    // Set error cooldown for this conversation
    conversationErrorCooldown.set(
      conversationKey,
      Date.now() + ERROR_COOLDOWN_MS,
    );
  } finally {
    activeRequests--;
    conversationProcessing.delete(conversationKey);
  }
}

/**
 * Debounced analysis trigger for a conversation
 */
function scheduleConversationAnalysis(conversationKey: string): void {
  // Skip if already processing
  if (conversationProcessing.has(conversationKey)) {
    logger.debug(
      { conversationKey },
      "Conversation already processing, skipping schedule",
    );
    return;
  }

  // Skip if in error cooldown
  const cooldownUntil = conversationErrorCooldown.get(conversationKey);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    logger.debug(
      { conversationKey, cooldownMs: cooldownUntil - Date.now() },
      "Conversation in error cooldown, skipping schedule",
    );
    return;
  }

  // Clear existing timer
  const existingTimer = conversationDebounceTimers.get(conversationKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new debounced timer
  const timer = setTimeout(async () => {
    conversationDebounceTimers.delete(conversationKey);

    // If activeRequests >= MAX_ACTIVE_REQUESTS, requeue instead of waiting
    if (activeRequests >= MAX_ACTIVE_REQUESTS) {
      logger.debug(
        { conversationKey, activeRequests },
        "Max active requests reached, requeuing conversation",
      );
      scheduleConversationAnalysis(conversationKey);
      return;
    }

    // Get pending messages for this conversation
    const messages = await getPendingMessagesByConversation(
      conversationKey,
      MAX_BATCH_SIZE,
    );

    if (messages.length > 0) {
      await processBatch(conversationKey, messages);
    }
  }, DEBOUNCE_MS);

  conversationDebounceTimers.set(conversationKey, timer);
}

/**
 * Queues a message for analysis (debounced by conversation)
 */
export async function queueMessageAnalysis(messageId: string): Promise<void> {
  if (!config.AI_ANALYSIS_ENABLED) return;

  logger.debug({ messageId }, "Queueing message for analysis");

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

  logger.debug({ conversationKey }, "Queueing conversation for analysis");

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
  if (!config.AI_ANALYSIS_ENABLED) {
    logger.info("AI analysis disabled");
    return;
  }

  logger.info("AI analysis worker started");

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

        logger.debug(
          { conversationKey: key },
          "Recovering pending conversation",
        );
        scheduleConversationAnalysis(key);
      }
    } catch (error) {
      logger.error({ error }, "Pending AI analysis recovery worker failed");
    }
  }, RECOVERY_INTERVAL_MS);
}
