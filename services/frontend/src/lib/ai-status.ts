import type { AiStatus, VerdictStatus } from "@/lib/types";

export type AiTone = "signal" | "amber" | "vermilion" | "neutral";

/**
 * Colour for a message's moderation badge.
 *
 * The tone is decided by the VERDICT, not the pipeline status. This used to
 * read `ai_status` and test for "clean" / "warn" / "flagged" — but the worker
 * only ever writes `analyzed` to that column, so every single judged message
 * fell through to `neutral` and the badge was grey regardless of outcome.
 *
 * Precedence: the verdict if there is one, otherwise the pipeline state, so an
 * unjudged-but-failing message still reads as a problem.
 */
export function aiTone(
  verdict?: VerdictStatus | null,
  pipeline?: AiStatus | null,
): AiTone {
  if (verdict === "flagged") return "vermilion";
  if (verdict === "error") return "vermilion";
  if (verdict === "warn") return "amber";
  if (verdict === "clean") return "signal";

  // No verdict. Fall back to how the pipeline is doing.
  // `dead` is the only pipeline state that needs a human.
  if (pipeline === "dead") return "vermilion";
  return "neutral";
}

/**
 * Short label for the badge. Kept terse because it sits inline next to a
 * username in dense message lists.
 */
export function aiLabel(
  verdict?: VerdictStatus | null,
  pipeline?: AiStatus | null,
): string {
  if (verdict) return verdict;

  // No verdict — report the queue state honestly rather than implying "clean".
  switch (pipeline) {
    case "pending":
      return "queued";
    case "claimed":
      return "analysing";
    case "retry_wait":
      return "retrying";
    case "dead":
      return "failed";
    case "analyzed":
      // Finished with no verdict row. Real, and worth surfacing: it is what a
      // message analysed by the old pipeline looks like.
      return "unjudged";
    default:
      return "unknown";
  }
}

/**
 * True when a message needs a human. Deliberately conservative — this drives
 * "needs attention" UI, so anything borderline stays out of it.
 */
export function needsReview(
  verdict?: VerdictStatus | null,
  pipeline?: AiStatus | null,
): boolean {
  return (
    verdict === "warn" ||
    verdict === "flagged" ||
    verdict === "error" ||
    pipeline === "dead"
  );
}
