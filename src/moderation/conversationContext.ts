import type { MessageRecord } from "./types";

export interface ConversationContextInput {
  contextBefore: MessageRecord[];
  targets: MessageRecord[];
  maxTokens: number;
}

/**
 * Formats a timestamp to ISO 8601 string
 */
function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Estimates token count for a string (rough approximation: ~4 chars per token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Builds conversation prompt messages with context and targets
 * - Marks target messages with [target], prior context with [context]
 * - Uses edited_content when present, otherwise content
 * - Maintains chronological order
 * - Respects maxTokens budget, prioritizing targets and most recent context
 */
export function buildConversationPromptMessages(
  input: ConversationContextInput,
): string[] {
  const { contextBefore, targets, maxTokens } = input;

  const formatMessage = (msg: MessageRecord, label: string): string => {
    const content = msg.edited_content ?? msg.content;
    const timestamp = formatTimestamp(msg.created_at);
    return `[${label}] id=${msg.id} time=${timestamp} user=${msg.username}: ${content}`;
  };

  const targetEntries = targets.map((msg) => ({
    msg,
    label: "target" as const,
    line: formatMessage(msg, "target"),
  }));

  let usedTokens = targetEntries.reduce(
    (sum, entry) => sum + estimateTokens(entry.line),
    0,
  );

  const selectedContextEntries: Array<{
    msg: MessageRecord;
    label: "context";
    line: string;
  }> = [];
  for (let i = contextBefore.length - 1; i >= 0; i--) {
    const msg = contextBefore[i];
    const line = formatMessage(msg, "context");
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens <= maxTokens) {
      selectedContextEntries.push({ msg, label: "context", line });
      usedTokens += lineTokens;
    }
  }

  return [...selectedContextEntries, ...targetEntries]
    .sort((a, b) => a.msg.created_at - b.msg.created_at)
    .map((entry) => entry.line);
}
