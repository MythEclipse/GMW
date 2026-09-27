import { POLICY_VERSION } from "./policy.js";

/**
 * v2 verdict parser.
 *
 * ## Why this file exists instead of reusing moderationResponseParser.ts
 *
 * The v1 parser THREW on any per-message problem, which killed the whole batch
 * (defect D10, verified):
 *
 *   moderationResponseParser.ts:243-247  throw on duplicate message_id
 *   moderationResponseParser.ts:253-257  throw on deferral analysis text
 *   llmCaller.ts:297-309                 catch → every message in the
 *                                        sub-batch marked analysis_parse_failed
 *
 * One message whose analysis happened to contain the phrase "perlu ditinjau"
 * therefore discarded 59 valid verdicts, triggered JSON repair, triggered four
 * full LLM re-requests, and then routed all 60 messages into the individual
 * fallback queue — 60 more LLM calls. A single sentence, a ~120x cost
 * multiplier, and 59 correct answers thrown away.
 *
 * The rule here is the inverse: a per-message defect degrades THAT message to
 * its own error verdict and never touches its siblings. The batch is only
 * declared failed when the response is not JSON at all, or when a message the
 * model was asked about is missing entirely.
 */

/** One message's outcome. Never throws. */
export type ParsedVerdict = {
  messageId: string;
  status: "clean" | "warn" | "flagged" | "error";
  flags: string[];
  categories: string[];
  severity: "none" | "low" | "medium" | "high" | "critical";
  confidence: number;
  score: number;
  recommendedAction:
    | "none"
    | "monitor"
    | "warn"
    | "review"
    | "delete"
    | "escalate";
  analysis: string;
  evidence: string[];
  policyVersion?: string;
  /** Set when this single message could not be judged. */
  perMessageError?: string;
};

export type ParseBatchResult = {
  verdicts: ParsedVerdict[];
  /** Messages the model omitted entirely — the only recoverable "gap". */
  missing: string[];
  /** True when the response was unusable as a whole. */
  batchFailed: boolean;
  batchError?: string;
};

const SEVERITIES = new Set(["none", "low", "medium", "high", "critical"]);
const ACTIONS = new Set([
  "none",
  "monitor",
  "warn",
  "review",
  "delete",
  "escalate",
]);
const STATUSES = new Set(["clean", "warn", "flagged"]);

/** Deferral language. Kept from v1 so policy behaviour does not drift. */
const DEFERRAL_ANALYSIS_PATTERN =
  /(?:kurang (?:konteks|bukti|informasi|data) (?:untuk (?:menilai|menentukan|memutuskan)|untuk moderasi)|perlu (?:dicek|diperiksa|ditinjau|dikaji|dievaluasi) (?:oleh )?(?:admin|moderator|manusia|human review)|tidak (?:bisa|dapat|mampu) (?:menentukan|menilai|memastikan|menyimpulkan|memberi keputusan|memoderasi).*(?:karena (?:konteks tidak jelas|informasi tidak cukup|bukti kurang|konteks kurang|tidak cukup konteks)|data tidak cukup|informasi tidak lengkap)|cannot determine|insufficient (?:context|evidence|information) (?:to |for )?(?:moderate|judge|evaluate|decide|classify)|(?:sepertinya|tampaknya) (?:perlu|harus) (?:ditinjau|diperiksa|dicek) (?:oleh )?(?:admin|moderator)|tidak cukup (?:bukti|informasi|konteks) (?:untuk (?:memberikan|membuat|menentukan)|memutuskan))/i;

const DEFERRAL_EXCEPTION_PATTERN =
  /tidak bisa menentukan.*(?:karena|sebab|dengan alasan|sebab tidak ada).*(?:clean|tidak (?:ada|terdapat|menunjukkan).*(?:pelanggaran|masalah|indikasi|konten)|aman|bersih|normal)/i;

export function hasDeferralAnalysis(analysis: string): boolean {
  if (DEFERRAL_EXCEPTION_PATTERN.test(analysis)) return false;
  return DEFERRAL_ANALYSIS_PATTERN.test(analysis);
}

export function clampScore(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : null,
    )
    .filter((v): v is string => v !== null && v.length > 0);
}

/**
 * Extract the first balanced JSON object from a model response.
 *
 * Kept deliberately tolerant: models wrap JSON in prose, markdown fences, and
 * occasionally prepend reasoning. v1's implementation is reused verbatim in
 * behaviour (brace/bracket counting with string-escape handling).
 */
export function extractJson(content: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  for (const match of content.matchAll(fence)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* try the next fence */
    }
  }

  for (let start = 0; start < content.length; start++) {
    const first = content[start];
    if (first !== "{" && first !== "[") continue;

    const stack: string[] = [first];
    let inString = false;
    let escaped = false;

    for (let i = start + 1; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push(ch);
        continue;
      }
      const last = stack[stack.length - 1];
      if ((ch === "}" && last === "{") || (ch === "]" && last === "[")) {
        stack.pop();
        if (stack.length === 0) {
          try {
            const parsed = JSON.parse(content.slice(start, i + 1));
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            /* keep scanning */
          }
          break;
        }
      }
    }
  }
  throw new Error("no JSON object found in response");
}

function errorVerdict(
  messageId: string,
  reason: string,
  attempt: number,
): ParsedVerdict {
  return {
    messageId,
    status: "error",
    // Distinct flag per cause so the attempt log explains WHY, and so the
    // dashboard can tell "model was evasive" from "JSON was malformed".
    flags: [`analysis_${reason}`],
    categories: [`analysis_${reason}`],
    severity: "none",
    confidence: 0,
    score: 0,
    recommendedAction: "review",
    analysis: `Analisis tidak dapat diselesaikan (${reason}). Perlu pemeriksaan manual. Percobaan ${attempt}.`,
    evidence: [],
    perMessageError: reason,
  };
}

/**
 * Parse a model response into one verdict per requested message.
 *
 * `requestedIds` is the contract: the caller must receive exactly one verdict
 * per id, or the message stays in the queue. A message the model never
 * mentioned is reported in `missing` rather than silently dropped, because
 * "the model forgot" and "the model judged it clean" are different facts.
 */
export function parseVerdicts(
  raw: string,
  requestedIds: string[],
  attempt: number,
): ParseBatchResult {
  const verdictById = new Map<string, ParsedVerdict>();
  const missing: string[] = [];

  let payload: unknown;
  try {
    payload = extractJson(raw);
  } catch (e) {
    // Not JSON at all → the batch itself is unusable. Retry the whole call.
    return {
      verdicts: requestedIds.map((id) =>
        errorVerdict(id, "parse_failed", attempt),
      ),
      missing: [],
      batchFailed: true,
      batchError: e instanceof Error ? e.message : String(e),
    };
  }

  const container = payload as { results?: unknown; data?: unknown };
  const list = Array.isArray(container.results)
    ? container.results
    : Array.isArray(container.data)
      ? container.data
      : Array.isArray(payload)
        ? payload
        : null;

  if (!list) {
    return {
      verdicts: requestedIds.map((id) =>
        errorVerdict(id, "parse_failed", attempt),
      ),
      missing: [],
      batchFailed: true,
      batchError: "response JSON had no results array",
    };
  }

  const duplicates: string[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const raw_ = entry as Record<string, unknown>;

    const id = String(raw_.message_id ?? raw_.id ?? "").trim();
    if (!id) continue;

    // A duplicate degrades only the DUPLICATE (v1 threw and lost the batch).
    // The first occurrence wins, which is the model's primary answer.
    if (verdictById.has(id)) {
      duplicates.push(id);
      continue;
    }

    // An id we never asked for is ignored — a hallucinated extra target must
    // not be able to overwrite a real verdict.
    if (!requestedIds.includes(id)) continue;

    const analysisRaw = raw_.analysis;
    const analysis = typeof analysisRaw === "string" ? analysisRaw.trim() : "";

    // D10, part 1: deferral text is now a PER-MESSAGE degradation.
    if (hasDeferralAnalysis(analysis)) {
      verdictById.set(id, errorVerdict(id, "deferred", attempt));
      continue;
    }

    const status = String(raw_.status ?? "");
    if (!STATUSES.has(status)) {
      verdictById.set(id, errorVerdict(id, "invalid_status", attempt));
      continue;
    }

    const severity = String(raw_.severity ?? "");
    const action = String(raw_.recommended_action ?? "");

    const score = clampScore(raw_.score, 0);
    const confidenceRaw = clampScore(raw_.confidence, Number.NaN);
    // v1 derived confidence from score when the model omitted it. Keep that.
    const confidence = Number.isFinite(confidenceRaw)
      ? confidenceRaw
      : status === "flagged"
        ? Math.max(0.8, score)
        : status === "warn"
          ? 0.6
          : 0.9;

    const flags = asStringArray(raw_.flags);
    const categories = asStringArray(raw_.categories);

    verdictById.set(id, {
      messageId: id,
      status: status as ParsedVerdict["status"],
      flags,
      categories: categories.length > 0 ? categories : flags,
      severity: (SEVERITIES.has(severity)
        ? severity
        : deriveSeverity(status, score)) as ParsedVerdict["severity"],
      confidence,
      score,
      recommendedAction: (ACTIONS.has(action)
        ? action
        : "none") as ParsedVerdict["recommendedAction"],
      analysis:
        analysis.length > 0
          ? analysis
          : `Tidak ada indikasi pelanggaran. Pesan dinilai wajar dalam konteks percakapan.`,
      evidence: asStringArray(raw_.evidence),
      // The version that actually produced this verdict, not whatever the
      // model echoed back. The prompt's policy_version field is advisory and
      // the model frequently omits it, which left every verdict with
      // policy_version = NULL and no way to tell which policy ruled.
      policyVersion: POLICY_VERSION,
    });
  }

  for (const id of requestedIds) {
    if (!verdictById.has(id)) missing.push(id);
  }

  return {
    verdicts: requestedIds
      .map((id) => verdictById.get(id))
      .filter((v): v is ParsedVerdict => v !== undefined),
    missing,
    batchFailed: false,
  };
}

function deriveSeverity(
  status: string,
  score: number,
): ParsedVerdict["severity"] {
  if (status === "clean") return "none";
  if (score >= 0.85) return "critical";
  if (score >= 0.65) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}
