/**
 * Maps a verdict onto the `moderation_actions` audit columns.
 *
 * The pre-rewrite `verdictToActionFields.ts` did this from the legacy
 * `messages.ai_*` columns. Those no longer hold the judgement, so the values
 * now come from the `verdicts` row, falling back to the legacy columns for
 * rows the backfill has not reached.
 */
import type { MessageLike, VerdictLike } from "./autoDeleteEligibility.js"

export interface VerdictActionFields {
	status: string
	categories: string
	flags: string
	confidence: number
	evidence: string
	score: number | null
	policy_version: string | null
}

function list(value: unknown): string {
	if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ")
	if (typeof value === "string" && value.length > 0) return value
	return ""
}

/**
 * The `evidence` column holds the quoted spans the model cited — the record slip
 * renders them under "Evidence kept", and the moderation repository parses them
 * back with `parseJsonArray` into `string[]`.
 *
 * It must therefore be written as a JSON array of citations. It previously
 * received `verdict.flags` (the category labels) as an array whenever any flags
 * were present, and the model's `analysis` prose otherwise — so a slip showed
 * `harassment` where it claimed to show the message text the model quoted, and
 * the column carried prose in the slot the reader parses as a list.
 */
function evidenceField(verdict?: VerdictLike | null): string {
	const citations = (verdict?.evidence ?? []).map(String).filter(Boolean)
	return citations.length > 0 ? JSON.stringify(citations) : ""
}

export function verdictToActionFields(
	message: MessageLike,
	verdict?: VerdictLike | null,
	policyVersion?: string | null,
): VerdictActionFields {
	const status = verdict?.status ?? message.ai_status ?? "unknown"
	const confidence =
		verdict?.confidence ??
		message.ai_confidence ??
		message.ai_moderation_score ??
		0
	const score = verdict?.score ?? message.ai_moderation_score ?? null
	const categories = list(verdict?.categories) || message.ai_categories || ""
	const flags = list(verdict?.flags) || message.ai_moderation_flags || ""

	return {
		status,
		categories,
		flags,
		confidence,
		evidence: evidenceField(verdict),
		score,
		// `verdict.policyVersion` is the version that ACTUALLY ruled — the parser
		// stamps it from POLICY_VERSION, and the worker writes it to
		// `verdicts.policy_version`. The explicit argument stays supported for
		// callers that resolve it themselves.
		policy_version: policyVersion ?? verdict?.policyVersion ?? null,
	}
}
