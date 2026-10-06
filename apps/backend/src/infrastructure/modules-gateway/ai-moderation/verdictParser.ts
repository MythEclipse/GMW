import { POLICY_VERSION } from "./policy.js"

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

/**
 * One message's outcome. Never throws.
 *
 * `status` IS the decision, and it is two-valued because there is nothing in
 * between: `severity` and the six-valued `recommended_action` are both gone.
 * A message is either a violation to remove or it is clean — no review tier,
 * full auto. `status` rather than a separate boolean is deliberate: the
 * decision and the column that stores it stay one fact, not two that can drift.
 *
 * `error` remains a third value because "could not judge" is a real outcome and
 * not a synonym for "clean". An unreadable message must reach a human rather
 * than being deleted on no evidence or silently blessed.
 */
export type ParsedVerdict = {
	messageId: string
	/** THE decision. `deleted` means "remove this"; `error` means "needs a human". */
	status: "clean" | "deleted" | "error"
	/**
	 * WHICH enforcement the model chose, as a three-valued disposition.
	 *
	 * Deliberately NOT a second decision: `status` still says whether the message
	 * is a violation, and `action` says what happens to it. `clean` and
	 * `delete_message` are DERIVED from `status` and carry no new information.
	 * `reset_nickname` is the one outcome `status` cannot express — the violation
	 * lives in the member's name while the message itself stays up in Discord —
	 * so this is the only place the model's disposition survives.
	 */
	action: VerdictAction
	/** Required when `status` is `deleted`; the cause of the violation. */
	reason?: string
	flags: string[]
	categories: string[]
	confidence: number
	score: number
	analysis: string
	evidence: string[]
	policyVersion?: string
	/** Set when this single message could not be judged. */
	perMessageError?: string
}

export type ParseBatchResult = {
	verdicts: ParsedVerdict[]
	/** Messages the model omitted entirely — the only recoverable "gap". */
	missing: string[]
	/** True when the response was unusable as a whole. */
	batchFailed: boolean
	batchError?: string
}

/**
 * The outcomes a verdict may claim. `clean` and `deleted` are the only two real
 * answers — there is no review tier, so the pipeline is full auto and every
 * violation is removed. An unknown value is an `error`, not a guess.
 */
const STATUSES = new Set(["clean", "deleted"])

/**
 * The three dispositions the MODEL may choose between.
 *
 * `status` answers "is this a violation"; this answers "what should happen to
 * it". The only outcome `status` cannot express is `reset_nickname`, because
 * the violation lives in the member's nickname and the message is correct
 * enough to stay — which is why the model has to be asked, rather than code
 * inferring it from prose the model itself wrote.
 *
 * Spelled as `moderation_actions.action_type` values on purpose: this string is
 * what the enforcer writes into the audit row, and it is free text in the
 * schema (no CHECK), so the two must not drift apart.
 */
export const VERDICT_ACTIONS = [
	"clean",
	"delete_message",
	"reset_nickname",
] as const

export type VerdictAction = (typeof VERDICT_ACTIONS)[number]

const ACTION_SET: ReadonlySet<string> = new Set(VERDICT_ACTIONS)

/**
 * Read a model-supplied `action` into the three-value set, or return null.
 *
 * Null means "the model did not give us a value we understand", and the caller
 * decides what to do about it. It deliberately does NOT guess: an unrecognised
 * disposition must be distinguishable from a deliberate `clean`, because a
 * hallucinated `action` field is exactly as untrustworthy as a hallucinated
 * `status` and must not be laundered into a decision.
 */
export function normaliseAction(value: unknown): VerdictAction | null {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	return ACTION_SET.has(trimmed) ? (trimmed as VerdictAction) : null
}

/**
 * The disposition a verdict takes when the model named none we understand.
 *
 * Derives from `status`, and from `status` ALONE — which is what makes this the
 * safe direction to fail in. `status` is the field that already gates every
 * deletion, so falling back to it reproduces exactly the behaviour that shipped
 * before `action` existed. The alternatives are both worse: defaulting a
 * `deleted` verdict to `clean` would silently stop every deletion in the
 * pipeline the first time a model ignored the new field, and defaulting a
 * `clean` one to `delete_message` would let a hallucinated field delete
 * messages outright.
 */
function actionFromStatus(status: string): VerdictAction {
	return status === "deleted" ? "delete_message" : "clean"
}

/**
 * The disposition to store, reconciling the model's answer with `status`.
 *
 * Exported because this is the single place the two fields are made to agree,
 * and a caller that writes `verdicts` needs the same rule the parser used —
 * writing the raw model value instead is how a self-contradictory row
 * (`status: 'deleted'`, `action: 'clean'`) appears.
 */
export function resolveAction(
	modelAction: VerdictAction | null,
	status: string,
): VerdictAction {
	// The one disposition `status` cannot express: a violation in the member's
	// name, with the message itself left standing. Honoured on a `clean` status
	// too, because it deletes nothing — it is the model's explicit statement that
	// a name needs resetting, and dropping it would be the same infer-from-prose
	// defect this field was added to remove.
	if (modelAction === "reset_nickname") return "reset_nickname"
	return actionFromStatus(status)
}

/** Deferral language. Kept from v1 so policy behaviour does not drift. */
const DEFERRAL_ANALYSIS_PATTERN =
	/(?:kurang (?:konteks|bukti|informasi|data) (?:untuk (?:menilai|menentukan|memutuskan)|untuk moderasi)|perlu (?:dicek|diperiksa|ditinjau|dikaji|dievaluasi) (?:oleh )?(?:admin|moderator|manusia|human review)|tidak (?:bisa|dapat|mampu) (?:menentukan|menilai|memastikan|menyimpulkan|memberi keputusan|memoderasi).*(?:karena (?:konteks tidak jelas|informasi tidak cukup|bukti kurang|konteks kurang|tidak cukup konteks)|data tidak cukup|informasi tidak lengkap)|cannot determine|insufficient (?:context|evidence|information) (?:to |for )?(?:moderate|judge|evaluate|decide|classify)|(?:sepertinya|tampaknya) (?:perlu|harus) (?:ditinjau|diperiksa|dicek) (?:oleh )?(?:admin|moderator)|tidak cukup (?:bukti|informasi|konteks) (?:untuk (?:memberikan|membuat|menentukan)|memutuskan))/i

const DEFERRAL_EXCEPTION_PATTERN =
	/tidak bisa menentukan.*(?:karena|sebab|dengan alasan|sebab tidak ada).*(?:clean|tidak (?:ada|terdapat|menunjukkan).*(?:pelanggaran|masalah|indikasi|konten)|aman|bersih|normal)/i

export function hasDeferralAnalysis(analysis: string): boolean {
	if (DEFERRAL_EXCEPTION_PATTERN.test(analysis)) return false
	return DEFERRAL_ANALYSIS_PATTERN.test(analysis)
}

export function clampScore(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.max(0, Math.min(1, n))
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value
		.map((v) =>
			typeof v === "string" ? v : typeof v === "number" ? String(v) : null,
		)
		.filter((v): v is string => v !== null && v.length > 0)
}

/**
 * Extract the first balanced JSON object from a model response.
 *
 * Kept deliberately tolerant: models wrap JSON in prose, markdown fences, and
 * occasionally prepend reasoning. v1's implementation is reused verbatim in
 * behaviour (brace/bracket counting with string-escape handling).
 */
export function extractJson(content: string): unknown {
	const trimmed = content.trim()
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			const parsed = JSON.parse(trimmed)
			if (parsed && typeof parsed === "object") return parsed
		} catch {
			/* fall through to fence and bracket scanner */
		}
	}

	const fence = /```(?:json)?\s*([\s\S]*?)\s*```/g
	for (const match of content.matchAll(fence)) {
		try {
			const parsed = JSON.parse(match[1].trim())
			if (parsed && typeof parsed === "object") return parsed
		} catch {
			/* try the next fence */
		}
	}

	for (let start = 0; start < content.length; start++) {
		const first = content[start]
		if (first !== "{" && first !== "[") continue

		const stack: string[] = [first]
		let inString = false
		let escaped = false

		for (let i = start + 1; i < content.length; i++) {
			const ch = content[i]
			if (inString) {
				if (escaped) escaped = false
				else if (ch === "\\") escaped = true
				else if (ch === '"') inString = false
				continue
			}
			if (ch === '"') {
				inString = true
				continue
			}
			if (ch === "{" || ch === "[") {
				stack.push(ch)
				continue
			}
			const last = stack[stack.length - 1]
			if ((ch === "}" && last === "{") || (ch === "]" && last === "[")) {
				stack.pop()
				if (stack.length === 0) {
					try {
						const parsed = JSON.parse(content.slice(start, i + 1))
						if (parsed && typeof parsed === "object") return parsed
					} catch {
						/* keep scanning */
					}
					break
				}
			}
		}
	}
	throw new Error("no JSON object found in response")
}

function errorVerdict(
	messageId: string,
	reason: string,
	attempt: number,
): ParsedVerdict {
	return {
		messageId,
		status: "error",
		// `clean`, and it is the only correct value: `status: "error"` means the
		// model could not read this message, which authorises no enforcement at
		// all. `actionFromStatus` happens to agree here, but stating the value
		// directly keeps "an error deletes nothing" independent of that helper.
		action: "clean",
		// Distinct flag per cause so the attempt log explains WHY, and so the
		// dashboard can tell "model was evasive" from "JSON was malformed".
		flags: [`analysis_${reason}`],
		categories: [`analysis_${reason}`],
		// Never delete on an error. "The model could not read this message" is not
		// evidence of a violation, and deleting on it is unrecoverable — the content
		// is gone and the judgement that justified removing it never happened.
		// Confidence 0 says so explicitly rather than leaving a stale high value
		// from a failed attempt to imply the model was sure.
		confidence: 0,
		score: 0,
		analysis: `Analisis tidak dapat diselesaikan (${reason}). Perlu pemeriksaan manual. Percobaan ${attempt}.`,
		evidence: [],
		perMessageError: reason,
	}
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
	const verdictById = new Map<string, ParsedVerdict>()
	const missing: string[] = []

	let payload: unknown
	try {
		payload = extractJson(raw)
	} catch (e) {
		// Not JSON at all → the batch itself is unusable. Retry the whole call.
		return {
			verdicts: requestedIds.map((id) =>
				errorVerdict(id, "parse_failed", attempt),
			),
			missing: [],
			batchFailed: true,
			batchError: e instanceof Error ? e.message : String(e),
		}
	}

	const container = payload as { results?: unknown; data?: unknown }
	const list = Array.isArray(container.results)
		? container.results
		: Array.isArray(container.data)
			? container.data
			: Array.isArray(payload)
				? payload
				: null

	if (!list) {
		return {
			verdicts: requestedIds.map((id) =>
				errorVerdict(id, "parse_failed", attempt),
			),
			missing: [],
			batchFailed: true,
			batchError: "response JSON had no results array",
		}
	}

	const duplicates: string[] = []

	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue
		const raw_ = entry as Record<string, unknown>

		const id = String(raw_.message_id ?? raw_.id ?? "").trim()
		if (!id) continue

		// A duplicate degrades only the DUPLICATE (v1 threw and lost the batch).
		// The first occurrence wins, which is the model's primary answer.
		if (verdictById.has(id)) {
			duplicates.push(id)
			continue
		}

		// An id we never asked for is ignored — a hallucinated extra target must
		// not be able to overwrite a real verdict.
		if (!requestedIds.includes(id)) continue

		const analysisRaw = raw_.analysis
		const analysis = typeof analysisRaw === "string" ? analysisRaw.trim() : ""

		// D10, part 1: deferral text is now a PER-MESSAGE degradation.
		if (hasDeferralAnalysis(analysis)) {
			verdictById.set(id, errorVerdict(id, "deferred", attempt))
			continue
		}

		const status = String(raw_.status ?? "")
		if (!STATUSES.has(status)) {
			verdictById.set(id, errorVerdict(id, "invalid_status", attempt))
			continue
		}

		const score = clampScore(raw_.score, 0)
		const confidenceRaw = clampScore(raw_.confidence, Number.NaN)
		// v1 derived confidence from score when the model omitted it. Keep that.
		const confidence = Number.isFinite(confidenceRaw)
			? confidenceRaw
			: status === "deleted"
				? Math.max(0.8, score)
				: 0.9

		const flags = asStringArray(raw_.flags)
		const categories = asStringArray(raw_.categories)

		const reason = typeof raw_.reason === "string" ? raw_.reason.trim() : ""

		// The model's disposition, or the pre-existing derivation if it named none
		// we understand.
		//
		// Never a degradation to `error`: unlike `status`, an unusable `action`
		// must not cost us the verdict. `status` is still valid, the judgement is
		// still real, and the whole batch would be one hallucinated field away from
		// being thrown away — the exact D10 failure this parser was rewritten to
		// eliminate. A bad disposition degrades the DISPOSITION.
		const modelAction = normaliseAction(raw_.action)

		// One rule, two cases: `reset_nickname` is the only disposition that
		// survives a contradicting `status`, and everything else is derived from it.
		//
		// Honoured on a `clean` status — the model found a name violation but
		// declined to call the message one. That deletes nothing, and it is the
		// model's explicit statement that a name needs resetting.
		//
		// Everything else follows `status`, because `status` is the field the schema
		// constrains and the only one that ever authorised a deletion. So an
		// explicit `clean` beside `status: "deleted"` collapses to
		// `delete_message`: the model cannot have meant "this is fine" in the same
		// breath as "delete it", and honouring the `clean` would mean one
		// inconsistent response silently switches enforcement off — the failure mode
		// 0025 was written to kill, where flagged verdicts sat unenforced. The
		// stored row is therefore never self-contradictory: a `deleted` verdict
		// always carries an action that does something.
		const action = resolveAction(modelAction, status)

		verdictById.set(id, {
			messageId: id,
			// `status` is already the decision — it is validated above to be exactly
			// one of clean/deleted — so nothing reconciles it and nothing overrides
			// it. The model states the outcome once and that value is the outcome.
			status: status as ParsedVerdict["status"],
			// The disposition the model chose, already reconciled with `status`
			// above and never an unrecognised value.
			action,
			// A deletion without a stated cause is a deletion a moderator cannot
			// audit or appeal, so it falls back to the model's own explanation rather
			// than to an empty string. The fallback is the analysis, not a literal
			// placeholder: a real sentence is worth more to a reviewer than "n/a".
			...(status === "deleted"
				? { reason: reason.length > 0 ? reason : analysis }
				: {}),
			flags,
			categories: categories.length > 0 ? categories : flags,
			confidence,
			score,
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
		})
	}

	for (const id of requestedIds) {
		if (!verdictById.has(id)) missing.push(id)
	}

	return {
		verdicts: requestedIds
			.map((id) => verdictById.get(id))
			.filter((v): v is ParsedVerdict => v !== undefined),
		missing,
		batchFailed: false,
	}
}
