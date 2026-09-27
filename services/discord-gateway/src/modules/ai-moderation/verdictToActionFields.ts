/**
 * Maps a verdict onto the `moderation_actions` audit columns.
 *
 * The pre-rewrite `verdictToActionFields.ts` did this from the legacy
 * `messages.ai_*` columns. Those no longer hold the judgement, so the values
 * now come from the `verdicts` row, falling back to the legacy columns for
 * rows the backfill has not reached.
 */
import type { MessageLike, VerdictLike } from "./autoDeleteEligibility.js";

export interface VerdictActionFields {
  status: string;
  severity: string;
  categories: string;
  flags: string;
  confidence: number;
  evidence: string;
  score: number | null;
  policy_version: string | null;
}

function list(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  if (typeof value === "string" && value.length > 0) return value;
  return "";
}

export function verdictToActionFields(
  message: MessageLike,
  verdict?: VerdictLike | null,
  policyVersion?: string | null,
): VerdictActionFields {
  const status = verdict?.status ?? message.ai_status ?? "unknown";
  const severity = verdict?.severity ?? message.ai_severity ?? "none";
  const confidence =
    verdict?.confidence ??
    message.ai_confidence ??
    message.ai_moderation_score ??
    0;
  const score = verdict?.score ?? message.ai_moderation_score ?? null;
  const categories = list(verdict?.categories) || message.ai_categories || "";
  const flags = list(verdict?.flags) || message.ai_moderation_flags || "";

  return {
    status,
    severity,
    categories,
    flags,
    confidence,
    // `evidence` is jsonb in the schema. Older rows stored a bare string, so a
    // plain string is still accepted; an array is stored as JSON.
    evidence: Array.isArray(verdict?.flags)
      ? JSON.stringify(verdict?.flags)
      : (verdict?.analysis ?? ""),
    score,
    policy_version: policyVersion ?? null,
  };
}
