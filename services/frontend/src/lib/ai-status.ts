import type {
  DisplayVerdict,
  PipelineStatus,
  Severity,
  VerdictStatus,
} from "./types";

/**
 * The moderation state machine, in one place.
 *
 * There are TWO independent axes and conflating them is the single most
 * expensive bug this dashboard has had:
 *
 *   `messages.ai_status`  — WHERE the message is in the queue.
 *                            pending | claimed | analyzed | retry_wait | dead
 *                            A hard CHECK constraint (migration 0020) rejects
 *                            anything else, so the v1 names ("processing",
 *                            "clean", "flagged"…) can never be written.
 *
 *   `verdicts.status`     — WHAT the model decided.
 *                            clean | warn | flagged | error
 *
 * So "still queued" and "judged clean" are different facts. A message that is
 * `pending` has no outcome yet; rendering it as clean is a lie, and a filter
 * written against `ai_status IN ('flagged')` can never match a row.
 */

export const PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "pending",
  "claimed",
  "analyzed",
  "retry_wait",
  "dead",
] as const;

export const VERDICT_STATUSES: readonly VerdictStatus[] = [
  "clean",
  "warn",
  "flagged",
  "error",
] as const;

export const SEVERITIES: readonly Severity[] = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
] as const;

/** True only for values the DB CHECK constraint will accept. */
export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return (
    typeof value === "string" &&
    (PIPELINE_STATUSES as readonly string[]).includes(value)
  );
}

export function isVerdictStatus(value: unknown): value is VerdictStatus {
  return (
    typeof value === "string" &&
    (VERDICT_STATUSES as readonly string[]).includes(value)
  );
}

export type VerdictTone = "neutral" | "positive" | "warning" | "danger";

/**
 * Map a verdict to a tone. `"unjudged"` is neutral, NOT positive: it means the
 * worker has not concluded, and painting it green would understate the backlog.
 */
export function verdictTone(
  verdict: DisplayVerdict | null | undefined,
): VerdictTone {
  switch (verdict) {
    case "flagged":
      return "danger";
    case "warn":
      return "warning";
    case "error":
      return "warning";
    case "clean":
      return "positive";
    default:
      return "neutral";
  }
}

export function verdictLabel(
  verdict: DisplayVerdict | null | undefined,
): string {
  switch (verdict) {
    case "flagged":
      return "Flagged";
    case "warn":
      return "Warn";
    case "error":
      return "Error";
    case "clean":
      return "Clean";
    case "unjudged":
      return "Unjudged";
    default:
      return "Unknown";
  }
}

/** Queue position as a label, with the meaning spelled out. */
export function pipelineLabel(
  status: PipelineStatus | null | undefined,
): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "claimed":
      return "Analyzing";
    case "analyzed":
      return "Analyzed";
    case "retry_wait":
      return "Retrying";
    case "dead":
      return "Abandoned";
    default:
      return "Unknown";
  }
}

export function pipelineTone(
  status: PipelineStatus | null | undefined,
): VerdictTone {
  switch (status) {
    case "dead":
      return "danger";
    case "retry_wait":
      return "warning";
    case "claimed":
      return "neutral";
    case "analyzed":
      return "positive";
    default:
      return "neutral";
  }
}

export function severityTone(
  severity: Severity | null | undefined,
): VerdictTone {
  switch (severity) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "neutral";
    default:
      return "positive";
  }
}

/**
 * A message needs a human when its pipeline state is `dead` (the worker gave
 * up) or its verdict is `error`. Everything else resolves on its own.
 */
export function needsHuman(message: {
  ai_status?: PipelineStatus | null;
  verdict_status?: DisplayVerdict | null;
}): boolean {
  return message.ai_status === "dead" || message.verdict_status === "error";
}

/**
 * Work still owed by the worker. `dead` is excluded on purpose — it is not
 * queued any more, it is abandoned, and conflating the two hides a stuck
 * pipeline behind a healthy-looking backlog number.
 */
export function isBacklogged(
  status: PipelineStatus | null | undefined,
): boolean {
  return (
    status === "pending" || status === "claimed" || status === "retry_wait"
  );
}
