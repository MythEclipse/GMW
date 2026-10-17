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
	 * WHICH enforcement applies, DERIVED from the violation category.
	 *
	 * Not the model's choice. `actionForCategories` computes it from
	 * `categories` plus `status`, and the model's own `action` field is
	 * discarded on the way in — a model asked to name its own disposition got
	 * it wrong in prod: 51 verdicts categorised `offensive_nickname` whose
	 * action still deleted the MESSAGE and left the nickname alone.
	 *
	 * So: the model answers "what rule was broken" (categories), the policy
	 * answers "what happens then" (this field). `clean` and `delete_message`
	 * follow `status`; `reset_nickname` is the one outcome `status` cannot
	 * express, because the violation lives in the member's NAME while the
	 * message itself stays up in Discord.
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
 * The violation categories that are enforced on the member's NAME.
 *
 * ## Why this list exists, and why it — not the model — picks the action
 *
 * Enforcement is a property of the POLICY, not of the model's opinion. A model
 * asked to name its own disposition gets it wrong in ways no prompt fixes: prod
 * had 51 verdicts whose category was `offensive_nickname` and whose action still
 * produced a deleted MESSAGE with the nickname left alone. The category was
 * right and the disposition was not.
 *
 * So the mapping is mechanical and lives here: a message whose only violation
 * category is a name category is enforced on the name (`reset_nickname`), and
 * everything else is enforced on the message (`delete_message`). The model is
 * still asked to identify the CATEGORY — that is judgement, and a model is
 * better at it than a regex — but it no longer chooses what happens.
 *
 * Adding a category here is how a new name-based rule gets name-based
 * enforcement. Nothing else needs to change.
 */
export const NAME_ONLY_CATEGORIES = [
	"offensive_nickname",
	"offensive_username",
] as const

const NAME_ONLY_CATEGORY_SET: ReadonlySet<string> = new Set(
	NAME_ONLY_CATEGORIES,
)

/**
 * The enforcement a verdict gets, derived from its CATEGORY and nothing else.
 *
 * This is the single rule. It deliberately takes no model-supplied `action`:
 * accepting one as an input is what let a model delete a message over a
 * nickname, and a parameter that must never be trusted is better absent from the
 * signature than validated inside it.
 *
 *  - `error` is inert. "Could not judge" is not evidence of a violation, so it
 *    can never authorise enforcement — the same reason it is not `deleted`.
 *  - A category set that is ENTIRELY name categories is a name violation. The
 *    body may still be rude — that is caught separately by
 *    `isEligibleForAutoDelete`/`isNicknameOnlyViolation`, which read the text —
 *    but the policy's judgement is that the name is what needs fixing.
 *  - Anything else follows `status`: `deleted` means the message goes.
 *
 * A category set that mixes name and content categories is NOT a name
 * violation: `["offensive_nickname", "harassment"]` says the body violates too,
 * so the message goes (and the manager resets the name alongside it).
 */
export function actionForCategories(
	categories: readonly string[] | null | undefined,
	status: string,
): VerdictAction {
	if (status === "error") return "clean"

	const cats = (categories ?? []).filter((c): c is string => Boolean(c))
	if (
		cats.length > 0 &&
		cats.every((category) => NAME_ONLY_CATEGORY_SET.has(category))
	) {
		return "reset_nickname"
	}

	return status === "deleted" ? "delete_message" : "clean"
}

/**
 * The categories a stored row effectively carries, and the action that follows.
 *
 * `categories` falls back to `flags` because the model routinely fills one field
 * and not the other, and the ENFORCEMENT is derived from this value while a
 * reader may be looking at the raw column. Computing the action from raw
 * `categories` in one place and from the fallback in another is how the two
 * disagree — the exact class of bug this whole change removes (a stored category
 * that says `offensive_nickname` next to an action that deleted the message).
 *
 * The fallback triggers on an EMPTY array, not merely on null, because `[]` is
 * what an unfilled array field arrives as. Treating `[]` as "answered, and the
 * answer is nothing" would silently drop the flags beside it.
 *
 * The manager runs in a DIFFERENT PROCESS from the worker that wrote the row, so
 * it re-derives rather than trusting the stored `action`: an older row, a
 * hand-written verdict, or a future writer can all hold a value this build has
 * never seen, and deriving means a legacy row is still classified by its
 * category.
 */
export function actionForVerdict(
	verdict:
		| {
				status?: string | null
				categories?: readonly string[] | null
				flags?: readonly string[] | null
		  }
		| null
		| undefined,
): VerdictAction {
	if (!verdict) return "clean"

	const categories = (verdict.categories ?? []).filter((c): c is string =>
		Boolean(c),
	)
	const flags = (verdict.flags ?? []).filter((f): f is string => Boolean(f))
	const effective = categories.length > 0 ? categories : flags

	return actionForCategories(effective, verdict.status ?? "pending")
}

/**
 * Read a stored `action` value into the three-value set, or return null.
 *
 * Null means "not a value we understand". It deliberately does NOT guess: an
 * unrecognised disposition must be distinguishable from a deliberate `clean`,
 * because a hallucinated `action` field is exactly as untrustworthy as a
 * hallucinated `status` and must not be laundered into a decision.
 *
 * Used to READ rows written by older builds, never to decide enforcement —
 * `actionForCategories` decides, and it does not accept this value as an input.
 */
export function normaliseAction(value: unknown): VerdictAction | null {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	return ACTION_SET.has(trimmed) ? (trimmed as VerdictAction) : null
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

		// The categories the row will actually carry. `flags` is the fallback
		// because the model often fills one field and not the other, and the
		// ENFORCEMENT is derived from this same value — computing the action from
		// the raw `categories` and storing the fallback would let the two disagree,
		// which is precisely the class of bug (action not following category) this
		// change removes.
		const effectiveCategories = categories.length > 0 ? categories : flags

		const reason = typeof raw_.reason === "string" ? raw_.reason.trim() : ""

		// The model's disposition is NOT read, and that is the point.
		//
		// `action` used to be a model-supplied field, and the model got it
		// wrong where it mattered most: prod had 51 verdicts correctly
		// categorised `offensive_nickname` whose action still deleted the
		// MESSAGE and left the nickname alone. The category was the reliable
		// output; the disposition was not. Enforcement is now derived from the
		// category by `actionForCategories`, so there is one rule instead of a
		// model opinion to police.
		//
		// Consequence: a stored row can no longer be self-contradictory. Both
		// fields now come from the same two inputs, so a `deleted` verdict always
		// carries an action that does something.
		const action = actionForCategories(effectiveCategories, status)

		verdictById.set(id, {
			messageId: id,
			// `status` is already the decision — it is validated above to be exactly
			// one of clean/deleted — so nothing reconciles it and nothing overrides
			// it. The model states the outcome once and that value is the outcome.
			status: status as ParsedVerdict["status"],
			// The enforcement the CATEGORY derived, never an unrecognised value.
			action,
			// A deletion without a stated cause is a deletion a moderator cannot
			// audit or appeal, so it falls back to the model's own explanation rather
			// than to an empty string. The fallback is the analysis, not a literal
			// placeholder: a real sentence is worth more to a reviewer than "n/a".
			...(status === "deleted"
				? { reason: reason.length > 0 ? reason : analysis }
				: {}),
			flags,
			categories: effectiveCategories,
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
