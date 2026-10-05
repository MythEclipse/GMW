/**
 * Auto-delete eligibility.
 *
 * The gate order and the reasoning are preserved from the pre-rewrite
 * `autoDeleteEligibility.ts` (271 lines, deleted in 2658b0dd) — the rules that
 * survive are the ones protecting against a deletion the EVIDENCE cannot
 * support (suppressed embeds, an unresolved bare-link preview, an excluded
 * channel, a category outside the operator's allow-list), not ones re-litigating
 * how serious the violation is.
 *
 * WHAT CHANGED: the input, twice over. The old code branched on
 * `message.ai_status`, which after the rewrite only ever means "the worker
 * finished" — it no longer carries the judgement. Eligibility now reads the
 * `verdicts` row, which does; legacy `messages.ai_*` is only consulted for rows
 * the backfill has not reached. And the decision itself is now the single
 * boolean `should_delete`: severity and the six-valued `recommended_action` are
 * gone, so a message the model says to delete is deleted instead of waiting on
 * a severity tier.
 */
import { config } from "../../shared/config/index.js"
import { createChildLogger } from "../../shared/logger/index.js"
// These read messages.metadata's embed list, so they have to come from the
// capture module that owns that shape rather than be reimplemented.
import {
	hasSuppressedEmbeds,
	isLinkOnlyPost,
	pairLinksWithEmbeds,
	parseRichMessageMetadata,
} from "../message-capture/messageMetadata.js"

const logger = createChildLogger("auto-delete-eligibility")

/**
 * The judgement a message needs before any enforcement decision.
 *
 * `status` is the decision. There is no severity and no recommended_action: the
 * model either says the message should be removed or it does not, and the
 * operator decided the pipeline is full-auto, so there is no review tier to fall
 * back to.
 */
export interface VerdictLike {
	status: string
	/**
	 * The model's disposition, as `verdicts.action` stores it: `clean`,
	 * `delete_message`, or `reset_nickname`.
	 *
	 * Optional and nullable because the column is new, so every row written
	 * before it reads NULL — and because `readVerdict`'s legacy `messages.ai_*`
	 * fallback has no equivalent at all. That is the degraded path, not the
	 * normal one: the enforcer derives the disposition from `status` when it is
	 * absent, which is exactly the behaviour that shipped before the column
	 * existed.
	 */
	action?: string | null
	confidence?: number | null
	score?: number | null
	categories?: string[] | null
	flags?: string[] | null
	analysis?: string | null
}

export interface MessageLike {
	id: string
	guild_id: string
	channel_id: string
	user_id: string
	thread_id?: string | null
	/** Raw post body. Used to recognise a bare link post. */
	content?: string | null
	/** Captured rich evidence as JSON. Used to read the resolved embed. */
	metadata?: unknown
	// Legacy columns, used only when no verdict row exists yet.
	ai_status?: string | null
	ai_categories?: string | null
	ai_moderation_flags?: string | null
	ai_confidence?: number | null
	ai_moderation_score?: number | null
	ai_analysis?: string | null
}

/** Config values are comma-separated lists; JSON arrays are also accepted. */
export function parseStringList(value?: string | null): string[] {
	if (!value) return []
	const trimmed = value.trim()
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			return Array.isArray(parsed)
				? parsed.map((v) => String(v).trim()).filter(Boolean)
				: []
		} catch {
			// fall through to comma splitting
		}
	}
	return trimmed
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean)
}

/**
 * `messages.metadata` is a `jsonb` column, so the driver can hand it back
 * either as a string or as a parsed object. The capture-side helpers take the
 * string form (that is what `parseRichMessageMetadata` reads), so normalise
 * here instead of widening the helpers to accept `unknown`.
 */
function coerceMetadataJson(metadata: unknown): string | null {
	if (typeof metadata === "string") return metadata
	if (metadata && typeof metadata === "object") {
		try {
			return JSON.stringify(metadata)
		} catch {
			return null
		}
	}
	return null
}

/** Read a verdict's fields, falling back to the legacy columns. */
function readVerdict(
	message: MessageLike,
	verdict?: VerdictLike | null,
): VerdictLike {
	if (verdict) return verdict
	return {
		status: message.ai_status ?? "pending",
		confidence: message.ai_confidence ?? message.ai_moderation_score ?? null,
		score: message.ai_moderation_score ?? null,
		categories: parseStringList(message.ai_categories),
		flags: parseStringList(message.ai_moderation_flags),
		analysis: message.ai_analysis ?? null,
	}
}

export function parseModerationFlags(
	message: MessageLike,
	verdict?: VerdictLike | null,
): string[] {
	const v = readVerdict(message, verdict)
	if (v.flags && v.flags.length > 0) return v.flags
	return []
}

const USERNAME_ATTRIBUTABLE_FLAGS = new Set([
	"offensive_username",
	"offensive_nickname",
	"identity_attack",
	"name_targeting",
])

/** Analysis text stating the message content itself is clean. */
const CONTENT_CLEAN_PATTERN =
	/(?:isi pesan\s*(?:hanya|bersih|tidak (?:melanggar|ada)|membahas|berisi|bukan)|pesan\s*(?:bersih|tidak (?:melanggar|ada))|tidak ada (?:diskusi|konten|indikasi|pelanggaran))/i

/**
 * Analysis text attributing the violation to the username.
 *
 * Deliberately ORDER-INSENSITIVE in practice: the trigger noun and the verb can
 * appear in either order, because Indonesian puts the topic after the verb
 * ("Pesan mengandung sindiran melalui nickname …") as often as before it
 * ("nickname … mengandung"). Both are ordinary sentences; only one matched.
 */
const USERNAME_ATTRIBUTION_PATTERN =
	/(?:username|nickname|nama pengguna)[\s\S]{0,60}?(?:mengandung|memiliki|berisi|melanggar|ofensif|mengecam|menyerang)|(?:mengandung|memiliki|berisi|melanggar|menyerang)[\s\S]{0,60}?(?:username|nickname|nama pengguna)/i

/**
 * Terms that are insulting on their own, wherever they appear.
 *
 * Only used to decide WHERE a violation lives (the name vs the message), never
 * to judge the message itself — that judgement is the model's. Kept small and
 * unambiguous on purpose: a word that is only rude in context does not belong,
 * because this decides whether a real message is spared or deleted.
 */
const INSULT_TERMS = [
	"anjing",
	"babi",
	"bangsat",
	"cuking",
	"goblok",
	"idiot",
	"jancok",
	"kampret",
	"kontol",
	"kret",
	"memek",
	"mulin",
	"tenggelam",
	"tolol",
]

function normaliseName(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Whether the member's own NICKNAME contains an insulting term, and the message
 * body does not.
 *
 * This is the EVIDENCE-based counterpart to the prose patterns above. Those read
 * the model's free-text summary, so any rephrasing defeats them — and in
 * production it defeated them: a verdict whose flag was plain `harassment` and
 * whose analysis placed "mengandung" before "nickname" fell through both paths
 * and the MESSAGE was deleted, while the nickname (the actual violation) was
 * left in place. Prose is not a reliable carrier of a safety decision.
 *
 * Here the claim is checked against the names themselves, which are already
 * captured in `messages.metadata` and cannot be reworded by the model.
 *
 * Both halves are required. A body that itself contains the term is a real
 * message-level violation and must still be deletable; only a violation that
 * lives SOLELY in the name earns the nickname reset.
 *
 * Note for callers: a FALSE result is ambiguous. It means either "no nickname
 * violation" or "a nickname violation plus a rude body", and those two demand
 * opposite enforcement. Ask `isEligibleForAutoDelete` to tell them apart rather
 * than reading this as "no nickname problem" — doing so is how a body violation
 * gets spared by a name complaint.
 */
function nicknameCarriesInsult(message: MessageLike): boolean {
	const nick = readServerNickname(message)
	if (!nick) return false

	const cleanNick = normaliseName(nick)
	if (!INSULT_TERMS.some((term) => cleanNick.includes(term))) return false

	// The message must be clean of the same terms, or this is a message-level
	// violation that happens to accompany a rude name — not a nickname-only one.
	const body = normaliseName(message.content ?? "")
	return !INSULT_TERMS.some((term) => body.includes(term))
}

/**
 * The per-guild nickname as captured at message time, if any.
 *
 * `messages.metadata` is a TEXT column, so the enforcer hands this over as a
 * JSON *string*. That is the whole reason this guard was inert in production:
 * an earlier version tested `typeof metadata !== "object"` and returned null, so
 * the nickname was never read, `isNicknameOnlyViolation` fell through to the
 * delete path, and messages were deleted over a name while the name survived.
 * The unit test passed because its fixture was a parsed object — a test that
 * never sees the wire shape cannot catch this.
 *
 * `parseRichMessageMetadata` takes the string form, is already imported here for
 * the embed helpers, and is what every other consumer of this column uses.
 */
function readServerNickname(message: MessageLike): string | null {
	const raw = message.metadata
	if (!raw) return null

	// Accept both shapes: the wire gives a string, but a caller reaching this
	// module directly may hand over the parsed object.
	const parsed = typeof raw === "string" ? parseRichMessageMetadata(raw) : raw
	const member = (
		parsed as { member?: { nickname?: unknown; displayName?: unknown } } | null
	)?.member
	if (!member || typeof member !== "object") return null
	const nick = member.nickname ?? member.displayName
	return typeof nick === "string" && nick.trim().length > 0 ? nick.trim() : null
}

/**
 * True when the only problem is the server nickname, not the message.
 * Those get a nickname reset, never a delete.
 */
export function isNicknameOnlyViolation(
	message: MessageLike,
	verdict?: VerdictLike | null,
): boolean {
	// Path 0: the name itself carries the insult and the body does not. Checked
	// FIRST and independent of the flags, because it is the only path that cannot
	// be defeated by how the model chose to phrase its summary.
	if (nicknameCarriesInsult(message)) return true

	const flags = parseModerationFlags(message, verdict)
	if (flags.length === 0) return false

	// Path 1: exactly the offensive-username flag.
	if (flags.every((f) => f === "offensive_username")) return true

	// Path 2: username-attributable flags, corroborated by the analysis text.
	if (!flags.every((f) => USERNAME_ATTRIBUTABLE_FLAGS.has(f))) return false

	const analysis = readVerdict(message, verdict).analysis ?? ""
	if (!analysis) return false

	return (
		USERNAME_ATTRIBUTION_PATTERN.test(analysis) &&
		CONTENT_CLEAN_PATTERN.test(analysis)
	)
}

/**
 * Whether a message qualifies for auto-deletion.
 *
 * The decision itself is `should_delete` — the model says delete or it does not,
 * and there is no review tier to fall back to. Everything below the first gate
 * exists to stop a deletion that the evidence cannot support, NOT to second-guess
 * the model on judgement: a violation the operator's rules cover is deleted.
 */
export function isEligibleForAutoDelete(
	message: MessageLike,
	verdict?: VerdictLike | null,
): boolean {
	const v = readVerdict(message, verdict)
	const status = v.status

	// The decision. `status` is the only thing that authorises a deletion, and
	// `error` is a keep by construction — "could not judge" is not evidence of a
	// violation. There is no second field to consult and no tier to reach for.
	if (status !== "deleted") {
		logger.debug(
			{ messageId: message.id, status },
			"Message not eligible for auto-delete: verdict is not a deletion",
		)
		return false
	}

	const confidence = v.confidence ?? v.score ?? 0
	if (confidence < config.AUTO_DELETE_MIN_CONFIDENCE) {
		logger.debug(
			{
				messageId: message.id,
				confidence,
				threshold: config.AUTO_DELETE_MIN_CONFIDENCE,
			},
			"Message not eligible for auto-delete: confidence below threshold",
		)
		return false
	}

	// A message the sender deliberately hid is one we cannot judge. `SUPPRESS_EMBEDS`
	// makes Discord omit the embed array, so there is nothing to read and nothing
	// that will arrive later. A model handed a blank still emits a confident
	// deletion, and deleting on that is unrecoverable — this is the guard that
	// would have saved the 6 wrongly-deleted Facebook shares.
	const metadata = coerceMetadataJson(message.metadata)
	if (hasSuppressedEmbeds(metadata)) {
		logger.debug(
			{ messageId: message.id },
			"Message not eligible for auto-delete: sender set SUPPRESS_EMBEDS, content is not judgeable",
		)
		return false
	}

	// A bare link post is judged almost entirely on the page it points to. The
	// pre-fix prompt never showed the model that page's preview, so an ordinary
	// Facebook share came back as a violation from the domain name alone and the
	// message was deleted. The preview is in the prompt now, but this guard stays
	// for the case where it genuinely could not be resolved: there the model is
	// reasoning from nothing, and deleting on that is unrecoverable.
	//
	// It used to be "high/critical severity only", which meant a bare link below
	// that tier could never be deleted at all. With the decision reduced to one
	// boolean there is no tier to compare, so the guard is the EVIDENCE instead:
	// a bare link post with no embed resolved for it is not judgeable, exactly
	// like a suppressed embed above. `pairLinksWithEmbeds` is what decides that —
	// `isLinkOnlyPost` only looks at the body.
	if (isLinkOnlyPost(message.content, metadata)) {
		const pairs = pairLinksWithEmbeds(message.content, metadata)
		const unresolved = pairs.filter((p) => p.embed === null)
		if (pairs.length === 0 || unresolved.length > 0) {
			logger.debug(
				{
					messageId: message.id,
					links: pairs.length,
					unresolved: unresolved.length,
				},
				"Message not eligible for auto-delete: bare link post with no resolved preview",
			)
			return false
		}
	}

	logger.debug(
		{ messageId: message.id, status },
		"Message eligible for auto-delete: model requested deletion and evidence gates passed",
	)

	const allowedCategories = parseStringList(
		config.AUTO_DELETE_ALLOWED_CATEGORIES,
	)
	if (allowedCategories.length > 0) {
		const messageCategories = v.categories ?? []
		const hasAllowedCategory = messageCategories.some((cat) =>
			allowedCategories.includes(cat),
		)
		if (!hasAllowedCategory) {
			logger.debug(
				{
					messageId: message.id,
					categories: messageCategories,
					allowed: allowedCategories,
				},
				"Message not eligible for auto-delete: no allowed categories match",
			)
			return false
		}
	}

	const excludedChannels = parseStringList(
		config.AUTO_DELETE_EXCLUDED_CHANNEL_IDS,
	)
	if (excludedChannels.length > 0) {
		const channelId = message.thread_id ?? message.channel_id
		if (excludedChannels.includes(channelId)) {
			logger.debug(
				{ messageId: message.id, channelId },
				"Message not eligible for auto-delete: channel excluded",
			)
			return false
		}
	}

	const excludedUsers = parseStringList(config.AUTO_DELETE_EXCLUDED_USER_IDS)
	if (excludedUsers.length > 0 && excludedUsers.includes(message.user_id)) {
		logger.debug(
			{ messageId: message.id, userId: message.user_id },
			"Message not eligible for auto-delete: user excluded",
		)
		return false
	}

	return true
}
