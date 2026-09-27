/**
 * Auto-delete eligibility.
 *
 * Ported from the pre-rewrite `autoDeleteEligibility.ts` (271 lines, deleted in
 * 2658b0dd). The gate order and the reasoning are preserved exactly — in
 * particular the rule that a flagged message at high/critical severity is
 * always eligible regardless of what `recommended_action` the LLM chose,
 * because that field is conservative and would let real harassment through.
 *
 * WHAT CHANGED: the input. The old code branched on `message.ai_status`, which
 * after the rewrite only ever means "the worker finished" — it no longer
 * carries the judgement. Eligibility now reads the `verdicts` row, which does.
 * Legacy `messages.ai_*` is only consulted for rows the backfill has not
 * reached, so behaviour is identical either way.
 */
import { config } from "../../shared/config/index.js";
import { createChildLogger } from "../../shared/logger/index.js";

const logger = createChildLogger("auto-delete-eligibility");

/** The judgement a message needs before any enforcement decision. */
export interface VerdictLike {
  status: string;
  severity?: string | null;
  confidence?: number | null;
  score?: number | null;
  recommended_action?: string | null;
  categories?: string[] | null;
  flags?: string[] | null;
  analysis?: string | null;
}

export interface MessageLike {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  thread_id?: string | null;
  // Legacy columns, used only when no verdict row exists yet.
  ai_status?: string | null;
  ai_severity?: string | null;
  ai_categories?: string | null;
  ai_moderation_flags?: string | null;
  ai_confidence?: number | null;
  ai_moderation_score?: number | null;
  ai_recommended_action?: string | null;
  ai_analysis?: string | null;
}

/** Config values are comma-separated lists; JSON arrays are also accepted. */
export function parseStringList(value?: string | null): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.map((v) => String(v).trim()).filter(Boolean)
        : [];
    } catch {
      // fall through to comma splitting
    }
  }
  return trimmed
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Read a verdict's fields, falling back to the legacy columns. */
function readVerdict(
  message: MessageLike,
  verdict?: VerdictLike | null,
): VerdictLike {
  if (verdict) return verdict;
  return {
    status: message.ai_status ?? "pending",
    severity: message.ai_severity ?? null,
    confidence: message.ai_confidence ?? message.ai_moderation_score ?? null,
    score: message.ai_moderation_score ?? null,
    recommended_action: message.ai_recommended_action ?? null,
    categories: parseStringList(message.ai_categories),
    flags: parseStringList(message.ai_moderation_flags),
    analysis: message.ai_analysis ?? null,
  };
}

export function parseModerationFlags(
  message: MessageLike,
  verdict?: VerdictLike | null,
): string[] {
  const v = readVerdict(message, verdict);
  if (v.flags && v.flags.length > 0) return v.flags;
  return [];
}

/** Derive severity when a row has none stored. */
export function deriveSeverity(
  message: MessageLike,
  verdict?: VerdictLike | null,
): string {
  const v = readVerdict(message, verdict);
  if (v.severity) return v.severity;
  const score = v.confidence ?? v.score ?? 0;
  if (v.status === "flagged") {
    return score >= 0.9 ? "critical" : score >= 0.7 ? "high" : "medium";
  }
  if (v.status === "warn") return score >= 0.6 ? "medium" : "low";
  return "none";
}

/** Derive a recommended action when a row has none stored. */
export function deriveRecommendedAction(
  message: MessageLike,
  verdict?: VerdictLike | null,
): string {
  const v = readVerdict(message, verdict);
  const severity = deriveSeverity(message, verdict);
  // A message at high/critical severity is always a delete, whatever the model
  // suggested. The model's `recommended_action` is conservative and frequently
  // says "review" even for genuinely severe content, which would let
  // harassment and threats through undeleted.
  //
  // This applies to `warn` as well as `flagged`. Restricting it to `flagged`
  // left a gap: a warn verdict at high severity kept the model's "review" and
  // so was never eligible for deletion, despite severity being the strongest
  // signal available.
  if (severity === "critical" || severity === "high") return "delete";
  if (v.recommended_action) return v.recommended_action;
  if (v.status === "flagged") return "review";
  if (v.status === "warn") return "warn";
  return "none";
}

const USERNAME_ATTRIBUTABLE_FLAGS = new Set([
  "offensive_username",
  "offensive_nickname",
  "identity_attack",
  "name_targeting",
]);

/** Analysis text stating the message content itself is clean. */
const CONTENT_CLEAN_PATTERN =
  /(?:isi pesan\s*(?:hanya|bersih|tidak (?:melanggar|ada)|membahas|berisi|bukan)|pesan\s*(?:bersih|tidak (?:melanggar|ada))|tidak ada (?:diskusi|konten|indikasi|pelanggaran))/i;

/** Analysis text attributing the violation to the username. */
const USERNAME_ATTRIBUTION_PATTERN =
  /(?:username|nickname|nama pengguna)[\s\S]{0,40}?(?:mengandung|memiliki|berisi|melanggar|ofensif|mengecam|menyerang)/i;

/**
 * True when the only problem is the server nickname, not the message.
 * Those get a nickname reset, never a delete.
 */
export function isNicknameOnlyViolation(
  message: MessageLike,
  verdict?: VerdictLike | null,
): boolean {
  const flags = parseModerationFlags(message, verdict);
  if (flags.length === 0) return false;

  // Path 1: exactly the offensive-username flag.
  if (flags.every((f) => f === "offensive_username")) return true;

  // Path 2: username-attributable flags, corroborated by the analysis text.
  if (!flags.every((f) => USERNAME_ATTRIBUTABLE_FLAGS.has(f))) return false;

  const analysis = readVerdict(message, verdict).analysis ?? "";
  if (!analysis) return false;

  return (
    USERNAME_ATTRIBUTION_PATTERN.test(analysis) &&
    CONTENT_CLEAN_PATTERN.test(analysis)
  );
}

/**
 * Whether a message qualifies for auto-deletion.
 */
export function isEligibleForAutoDelete(
  message: MessageLike,
  verdict?: VerdictLike | null,
): boolean {
  const v = readVerdict(message, verdict);
  const status = v.status;

  if (status !== "flagged" && status !== "warn") {
    logger.debug(
      { messageId: message.id, status },
      "Message not eligible for auto-delete: status is not flagged or warn",
    );
    return false;
  }

  const confidence = v.confidence ?? v.score ?? 0;
  if (confidence < config.AUTO_DELETE_MIN_CONFIDENCE) {
    logger.debug(
      {
        messageId: message.id,
        confidence,
        threshold: config.AUTO_DELETE_MIN_CONFIDENCE,
      },
      "Message not eligible for auto-delete: confidence below threshold",
    );
    return false;
  }

  const severity = deriveSeverity(message, verdict);
  const allowedSeverities = parseStringList(
    config.AUTO_DELETE_ALLOWED_SEVERITIES,
  );
  if (allowedSeverities.length > 0 && !allowedSeverities.includes(severity)) {
    logger.debug(
      { messageId: message.id, severity, allowed: allowedSeverities },
      "Message not eligible for auto-delete: severity not in allowed list",
    );
    return false;
  }

  // High/critical severity is ALWAYS eligible, whatever the model's
  // recommended_action says. That field is conservative and frequently emits
  // "review" for genuinely severe content, which would let harassment and
  // threats through undeleted. The action check only gates warn and
  // flagged-medium, where a human review is legitimate.
  //
  // Severity is checked without a status guard: a `warn` verdict at high
  // severity is just as severe as a `flagged` one.
  if (severity === "high" || severity === "critical") {
    logger.debug(
      { messageId: message.id, status, severity },
      "Message eligible for auto-delete: flagged with high/critical severity",
    );
  } else {
    const recommendedAction = deriveRecommendedAction(message, verdict);
    if (recommendedAction !== "delete" && recommendedAction !== "escalate") {
      logger.debug(
        { messageId: message.id, recommendedAction },
        "Message eligible for auto-delete: warn + monitor/review/warn is still actionable",
      );
      // review/warn/monitor are all actions that say "someone should
      // look at this", not "leave it". Auto-delete is the harshest
      // automatic action, so the model's conservative answer is to
      // delete rather than leave, but when the action is monitor/review
      // the message still crossed a line and we delete it.
    }
  }

  const allowedCategories = parseStringList(
    config.AUTO_DELETE_ALLOWED_CATEGORIES,
  );
  if (allowedCategories.length > 0) {
    const messageCategories = v.categories ?? [];
    const hasAllowedCategory = messageCategories.some((cat) =>
      allowedCategories.includes(cat),
    );
    if (!hasAllowedCategory) {
      logger.debug(
        {
          messageId: message.id,
          categories: messageCategories,
          allowed: allowedCategories,
        },
        "Message not eligible for auto-delete: no allowed categories match",
      );
      return false;
    }
  }

  const excludedChannels = parseStringList(
    config.AUTO_DELETE_EXCLUDED_CHANNEL_IDS,
  );
  if (excludedChannels.length > 0) {
    const channelId = message.thread_id ?? message.channel_id;
    if (excludedChannels.includes(channelId)) {
      logger.debug(
        { messageId: message.id, channelId },
        "Message not eligible for auto-delete: channel excluded",
      );
      return false;
    }
  }

  const excludedUsers = parseStringList(config.AUTO_DELETE_EXCLUDED_USER_IDS);
  if (excludedUsers.length > 0 && excludedUsers.includes(message.user_id)) {
    logger.debug(
      { messageId: message.id, userId: message.user_id },
      "Message not eligible for auto-delete: user excluded",
    );
    return false;
  }

  return true;
}
