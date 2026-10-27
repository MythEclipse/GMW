import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { ChevronRight } from "lucide-react"
import { formatNumber } from "#/libs/format"
import { Ticker } from "#/libs/motion"

/**
 * Statistic tile.
 *
 * `linear-tile` is the layout hook declared in styles.css; the surface is a
 * `hud-card` so a tile matches the panels around it.
 *
 * -- Why `to` exists (W2) ----------------------------------------------
 * A headline number is a claim about a list. "In queue 419" is only useful if
 * 419 is one click from the 419 rows that make it up, and every tile on the
 * dashboard used to be inert text -- including the one existing drill-down link
 * in the app, which pointed at a filter the target view did not read.
 *
 * So a tile WITH a `to` renders as a `Link` and becomes a control; a tile
 * WITHOUT one stays a `div`. The chevron appears only in the navigable case,
 * because an affordance that shows on a non-interactive element teaches the
 * user that affordances here mean nothing.
 *
 * -- Why `value` is a number and not a string ---------------------------
 * A tile whose figure changes under a WS push has to show that it changed, or
 * the reader cannot tell a fresh number from a stale one. Taking the raw number
 * plus a formatter is what lets the value tick to its new state (`Ticker`).
 * A tile whose value is not a number at all — a clock hour, a date — passes a
 * string instead and renders plainly.
 *
 * The `hint` is folded into the accessible name so a screen reader announces
 * the context, not just the number.
 */
export function StatTile({
	label,
	value,
	format = formatNumber,
	placeholder = "—",
	hint,
	tone = "neutral",
	to,
	/** The exact, unabbreviated number. See "Why `exact` exists" below. */
	exact,
	className,
}: {
	label: string
	/** Raw value: a number ticks, a string renders as given, null is a placeholder. */
	value: number | string | null | undefined
	format?: (n: number) => string
	placeholder?: string
	hint?: string
	tone?: "neutral" | "positive" | "warning" | "danger"
	/** When set, the whole tile becomes a link to this route. */
	to?: string
	/**
	 * The exact value behind an abbreviated `value`, e.g. `"49.724"` for
	 * `"49,7 rb"`. Rendered as a native tooltip on the number and announced
	 * after it for assistive tech.
	 */
	exact?: string
	className?: string
}) {
	const valueTone = {
		neutral: "text-ink",
		positive: "text-signal",
		warning: "text-amber",
		danger: "text-vermilion",
	}[tone]

	const display =
		value == null
			? placeholder
			: typeof value === "number"
				? format(value)
				: value

	// A formatter returns "—" for a missing value, so an `exact` built from the
	// same data would attach a tooltip and an sr-only "(—)" to a tile that has
	// nothing to say. Only carry it when there is a number behind it.
	const exactText = value == null ? undefined : exact

	const body = (
		<>
			<p className="field-label truncate">{label}</p>
			{/*
        `exact` exists because the headline numbers are abbreviated with
        `Intl.NumberFormat("id-ID")` compact notation, which renders 49,724 as
        "49,7 rb" — "rb" being *ribu*, Indonesian for thousand. That is correct
        localisation and correct at a glance, but it is a real comprehension
        barrier for anyone who does not read the suffix, and it is the one thing
        on this dashboard that stops a number from being verifiable at a glance.

        The exact figure goes in `title` (hover, and the native tooltip on
        keyboard focus) and in `sr-only` text, so it reaches both sighted users
        and screen readers without making the visual value any longer. Only
        emitted when the caller actually has a different string to show, so a
        tile that is not abbreviated does not gain a redundant tooltip.
      */}
			<p
				className={cn("metric-xl mt-1.5", valueTone)}
				{...(exactText ? { title: exactText } : {})}
			>
				{typeof value === "number" ? (
					<Ticker value={value} format={format} placeholder={placeholder} />
				) : (
					display
				)}
				{exactText && <span className="sr-only"> ({exactText})</span>}
			</p>
			{hint && <p className="mt-1.5 truncate text-xs text-ink-faint">{hint}</p>}
			{/* The chevron marks the tile as a control. It is aria-hidden because the
          link's own accessible name already carries label + value + hint. */}
			{to && (
				<ChevronRight
					className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
					aria-hidden
				/>
			)}
		</>
	)

	if (to) {
		return (
			<Link
				to={to}
				className={cn(
					"linear-tile hud-card group block px-4 py-3.5 transition-colors hover:border-hairline-focus",
					className,
				)}
				aria-label={`${label}: ${display}${exactText ? ` (${exactText})` : ""}${hint ? `. ${hint}` : ""}`}
			>
				{body}
			</Link>
		)
	}

	return (
		<div className={cn("linear-tile hud-card px-4 py-3.5", className)}>
			{body}
		</div>
	)
}

export function StatGrid({
	children,
	cols = 4,
}: {
	children: React.ReactNode
	cols?: 2 | 3 | 4
}) {
	const grid = {
		2: "grid-cols-2",
		3: "grid-cols-2 lg:grid-cols-3",
		4: "grid-cols-2 lg:grid-cols-4",
	}[cols]

	return <div className={cn("grid gap-3", grid)}>{children}</div>
}
