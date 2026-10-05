/**
 * Presentation helpers.
 *
 * Every timestamp in this system is EPOCH MILLISECONDS in a `bigint` column,
 * never a Postgres `timestamp` and never an ISO string from the API. Passing
 * one of these to `new Date()` is correct; passing it to a formatter that
 * expects seconds renders 1970.
 */

const numberFormatter = new Intl.NumberFormat("id-ID")
const compactFormatter = new Intl.NumberFormat("id-ID", {
	notation: "compact",
	maximumFractionDigits: 1,
})

export function formatNumber(value: number | null | undefined): string {
	if (value == null || Number.isNaN(value)) return "—"
	return numberFormatter.format(value)
}

export function formatCompact(value: number | null | undefined): string {
	if (value == null || Number.isNaN(value)) return "—"
	return compactFormatter.format(value)
}

export function formatPercent(
	value: number | null | undefined,
	digits = 1,
): string {
	if (value == null || Number.isNaN(value)) return "—"
	return `${value.toFixed(digits)}%`
}

export function formatDateTime(epochMs: number | null | undefined): string {
	if (epochMs == null) return "—"
	return new Date(epochMs).toLocaleString("id-ID", {
		dateStyle: "medium",
		timeStyle: "short",
	})
}

export function formatDate(epochMs: number | null | undefined): string {
	if (epochMs == null) return "—"
	return new Date(epochMs).toLocaleDateString("id-ID", { dateStyle: "medium" })
}

export function formatTime(epochMs: number | null | undefined): string {
	if (epochMs == null) return "—"
	return new Date(epochMs).toLocaleTimeString("id-ID", { timeStyle: "short" })
}

/** "3 minutes ago" / "just now" — for live feeds. */
export function formatRelative(
	epochMs: number | null | undefined,
	now = Date.now(),
): string {
	if (epochMs == null) return "—"
	const diff = now - epochMs
	if (diff < 0) return "just now"

	const seconds = Math.floor(diff / 1000)
	if (seconds < 45) return "just now"
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}d ago`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo ago`
	return `${Math.floor(months / 12)}y ago`
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || bytes <= 0) return "0 B"
	const units = ["B", "KB", "MB", "GB"]
	const exp = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	)
	const value = bytes / 1024 ** exp
	return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`
}

/** Truncate for a dense tile without cutting mid-word where avoidable. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text
	const slice = text.slice(0, max)
	const lastSpace = slice.lastIndexOf(" ")
	return `${lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice}…`
}

/** Turn a snake_case key into a human label: `nsfw_minor` → `Nsfw minor`. */
export function humanize(value: string): string {
	const spaced = value.replace(/[_-]+/g, " ").trim()
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * A readable stand-in for a message that has no useful text.
 *
 * Discord custom emoji are stored as `<:name:1234567890123456789>` (animated:
 * `<a:name:...>`). In a compact ranked row that token is ~40 characters of
 * noise: the "Most reacted messages" panel was rendering rows whose entire
 * label was `<:adobe:1520373128566411417>`, which is a snowflake with a name
 * glued on and tells the reader nothing.
 *
 * So the tokens fold to a short stand-in, and a message that is nothing BUT
 * emoji or a mention degrades to an empty string — letting the caller fall
 * back to something meaningful (the author, a generic label) rather than
 * showing a row of punctuation.
 */
export function messageLabel(
	content: string | null | undefined,
	max: number,
): string {
	const text = (content ?? "")
		.replace(/<a?:([a-zA-Z0-9_]{2,32}):\d{17,20}>/g, ":$1:")
		// A mention is identity, not content.
		.replace(/<@!?\d{17,20}>/g, "@someone")
		// Gateway placeholders for media-only messages; the panel cannot show the
		// media, so leaving the literal text is worse than dropping it.
		.replace(/\[(?:Sticker|Attachment|Image|GIF)[^\]]*\]/gi, "")
		.replace(/\s+/g, " ")
		.trim()

	return truncate(text, max)
}

/**
 * A message body, cleaned for display but NEVER truncated and never truncated
 * to a single line.
 *
 * This is `messageLabel`'s cleanup without its `max`, and it is a separate
 * function rather than `messageLabel(content, Infinity)` on purpose: the two
 * callers want genuinely different things. A ranked list wants one line; a
 * message card wants the whole message. Sharing a name for both would invite
 * the second call site to quietly get the first behaviour.
 *
 * The extra cleanup beyond `messageLabel` is the Discord-flavoured markdown
 * that a scanner would otherwise have to read through:
 *
 *   - `[label](url)` -> `label (url)`. The link stays visible, because for a
 *     moderation queue a destination is evidence, not decoration. It is NOT
 *     turned into an anchor: rendering untrusted message content as HTML is the
 *     one thing this dashboard must never do, and a markdown library would be
 *     a dependency plus a sanitiser to get there.
 *   - `**bold**`, `__bold__`, `*italic*`, `_italic_`, `~~strike~~` -> the text
 *     inside, unwrapped. Discord's own UI renders these; the card shows the
 *     author's words, not the source syntax.
 *   - `#` heading markers and `>` quote markers, which survive because people
 *     paste them, are dropped.
 *
 * Emoji are left exactly as they are — `:wave:` and `<:adobe:123>` are how the
 * author wrote them, and collapsing them would misrepresent the content. That is
 * also why this is a moderator view, not a re-implementation of Discord.
 */
export function messageBody(content: string | null | undefined): string {
	return (
		(content ?? "")
			.replace(/<a?:([a-zA-Z0-9_]{2,32}):\d{17,20}>/g, ":$1:")
			.replace(/<@!?\d{17,20}>/g, "@someone")
			.replace(/\[(Sticker|Attachment|Image|GIF)[^\]]*\]/gi, "")
			// Code fences and inline code keep their contents but lose the fences.
			.replace(/```(?:[a-zA-Z0-9+#-]*)\n?/g, "")
			.replace(/`([^`\n]+)`/g, "$1")
			// [label](url) -> label (url). Non-greedy label; url stops at whitespace
			// or a closing paren, which is what Discord itself accepts.
			.replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)")
			// Discord auto-links a bare angle-bracketed URL, and it also suppresses the
			// embed for it. Unwrap rather than drop: the destination is the content.
			.replace(/<((?:https?:\/\/|www\.)[^>\s]+)>/g, "$1")
			.replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
			.replace(/\*\*([^*\n]+)\*\*/g, "$1")
			.replace(/__([^_\n]+)__/g, "$1")
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, "$1$2")
			.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, "$1$2")
			.replace(/~~([^~\n]+)~~/g, "$1")
			.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
			.replace(/^[ \t]*>[ \t]?/gm, "")
			.replace(/[ \t]+$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	)
}

/** Discord snowflakes are strings; never coerce them through Number(). */
export function isSnowflake(value: unknown): value is string {
	return typeof value === "string" && /^\d{17,20}$/.test(value)
}

/**
 * Discord channel names are stored without the emoji prefix, so fall back to
 * the raw id rather than rendering an empty heading.
 */
export function channelLabel(name: string | null, id: string): string {
	return name && name.trim().length > 0 ? name : `#${id}`
}
