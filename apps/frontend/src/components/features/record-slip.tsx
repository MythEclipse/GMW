import { cn } from "cn"

/**
 * The Record Office — a moderation record as a filed slip.
 *
 * PRODUCT.md makes the evidence trail the product's positioning: a deletion is
 * only defensible in public if nothing in it is unexplained. So this component
 * renders the three things a member needs to judge the call themselves — the
 * message as posted, the policy clause it was judged against, and the reason
 * the model gave — and it never collapses them into a single "status" word.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT PLACES. `ai_status` is where a message
 * sits in the queue and `verdicts.status` is what was decided. A slip shows the
 * decision; the queue lives in the band beneath it. Rendering both in one pill
 * is the flattening PRODUCT.md forbids.
 *
 * An `error` verdict is NOT a soft delete: it means the model could not read
 * the message, so nothing was removed and nothing is stamped. The record is
 * honest about that rather than quietly showing a deletion.
 */

/** Verdict statuses, exactly as the backend emits them. */
export type TSlipVerdict = "clean" | "deleted" | "error"

/**
 * The filing-tab colour per verdict. This is the ONE place a slip's left edge
 * takes its colour, so a drawer of ten can be scanned on the tabs alone.
 *
 * Oxblood is spent only on `deleted`, filing green only on `clean`, and
 * `error` takes the neutral ink — an unread message is not an alert, it is an
 * absence. Each is applied via a named token class, never a raw hex: the
 * `shadcn/no-raw-colors` gate forbids one at the JSX site.
 */
const SLIP_TAB: Record<TSlipVerdict, string> = {
	deleted: "border-l-vermilion",
	clean: "border-l-success",
	error: "border-l-ink-faint",
}

/** The ink dot inside a slip's status line. Same discipline as the tab. */
const SLIP_DOT: Record<TSlipVerdict, string> = {
	deleted: "bg-vermilion",
	clean: "bg-success",
	error: "bg-ink-faint",
}

/**
 * Plain-language status line. PRODUCT.md's reader is the public membership, not
 * a trained moderation team, so `error` must never surface as the bare word:
 * the honest sentence is that nothing was removed, and why.
 */
const SLIP_STATUS_COPY: Record<TSlipVerdict, string> = {
	deleted: "Removed",
	clean: "Kept — no rule matched",
	error: "Not judged — nothing was removed",
}

function SlipStatus({ verdict }: { verdict: TSlipVerdict }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span
				aria-hidden
				className={cn("size-1.5 shrink-0 rounded-full", SLIP_DOT[verdict])}
			/>
			<span className="font-medium">{SLIP_STATUS_COPY[verdict]}</span>
		</span>
	)
}

/**
 * One labelled field on a slip. `value` is rendered as given: this component
 * never fabricates a missing field, so callers pass an explicit "—" or an
 * honest sentence rather than letting an empty cell imply the field was blank
 * on the record.
 */
function SlipField({
	label,
	value,
	mono = false,
}: {
	label: string
	value: string
	mono?: boolean
}) {
	return (
		<div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 border-b border-hairline py-2 last:border-b-0">
			<span className="field-label pt-0.5">{label}</span>
			<span
				className={cn(
					"min-w-0 text-sm text-ink-soft",
					mono && "font-mono text-xs tracking-wide",
				)}
			>
				{value}
			</span>
		</div>
	)
}

/**
 * The consulted slip: the one record pulled forward out of the drawer.
 *
 * `active` is what makes it a slip rather than a card — it leaves the drawer's
 * plane and gains a cast shadow, and nothing else on the page carries that
 * treatment, so "what am I reading" is answered by weight before position.
 */
export function RecordSlip({
	accession,
	channel,
	verdict,
	reason,
	clause,
	evidence,
	confidence,
	threshold,
	decidedAt,
	active = false,
	className,
}: {
	/** The record number a member quotes back. Stable, human-quotable. */
	accession: string
	channel: string
	verdict: TSlipVerdict
	/** Why the model decided this. Empty is rendered honestly, never hidden. */
	reason: string | null | undefined
	/** The policy clause it was judged against, e.g. "3.4 Scam links". */
	clause: string | null | undefined
	/** Quoted spans the model cited. Evidence, not decoration. */
	evidence: string[] | null | undefined
	confidence: number | null | undefined
	/** The auto-delete threshold this call was measured against. */
	threshold: number | null | undefined
	decidedAt: string
	active?: boolean
	className?: string
}) {
	const removed = verdict === "deleted"
	// The stamp attests a DECISION, so it is withheld from an unjudged record
	// rather than stamped "not judged" — a stamp on an absent decision would
	// read as an attestation that never happened.
	const showStamp = verdict !== "error"

	return (
		<article
			className={cn(
				active ? "record-slip-active" : "record-slip",
				SLIP_TAB[verdict],
				className,
			)}
		>
			<header className="flex flex-wrap items-start justify-between gap-2 border-b border-hairline px-4 py-3">
				<div className="min-w-0">
					<p className="accession">{accession}</p>
					<p className="mt-0.5 truncate text-sm text-ink-muted">
						{channel}
						<span className="mx-1.5 text-ink-faint">·</span>
						{decidedAt}
					</p>
				</div>
				{showStamp ? (
					<span className={cn("accession-stamp", !removed && "opacity-70")}>
						{removed ? "Removed" : "Filed"}
					</span>
				) : null}
			</header>

			<div className="px-4 py-3">
				<h3 className="text-sm font-medium tracking-wide text-ink">
					Why this message was {removed ? "removed" : "kept"}
				</h3>
				<p
					className={cn(
						"mt-1.5 text-sm",
						verdict === "error" ? "text-ink-muted" : "text-ink-soft",
					)}
				>
					{verdict === "error"
						? "The model could not read this message, so no rule was applied and nothing was removed. It is still in the channel."
						: (reason ?? "—")}
				</p>

				<dl className="mt-3">
					{/*
					 * The clause and the reason are the two fields a member needs to
					 * challenge the call, so they come first. On an unjudged record
					 * there IS no clause — inventing one would be the exact fiction
					 * PRODUCT.md forbids.
					 */}
					{verdict !== "error" && (
						<SlipField label="Policy clause" value={clause ?? "—"} />
					)}
					<SlipField label="Reason given by the model" value={reason ?? "—"} />
					{verdict !== "error" && confidence != null && (
						<SlipField
							label="Confidence"
							mono
							value={
								threshold != null
									? `${confidence.toFixed(2)} · delete threshold ${threshold.toFixed(2)}`
									: confidence.toFixed(2)
							}
						/>
					)}
				</dl>
			</div>

			{/* Evidence is quoted spans the model cited. Rendered as text, never
			    as HTML: message content is author-supplied and React escapes it. */}
			{evidence && evidence.length > 0 && (
				<div className="border-t border-hairline px-4 py-3">
					<p className="field-label">Evidence kept</p>
					<ul className="mt-1.5 space-y-1">
						{evidence.map((span) => (
							<li
								key={span}
								className="border-l-2 border-hairline pl-2 font-mono text-xs text-ink-muted"
							>
								{span}
							</li>
						))}
					</ul>
				</div>
			)}
		</article>
	)
}

/**
 * A drawer of filed records. The slip being consulted is lifted out and shown
 * beside it, so the grid holds only the *other* records — which is what makes
 * "pulled forward of" mean something rather than being a highlight colour.
 */
export function RecordDrawer({
	children,
	activeAccession,
	className,
}: {
	children: React.ReactNode
	/** The accession currently consulted, excluded from the drawer. */
	activeAccession?: string
	className?: string
}) {
	return (
		<div
			className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", className)}
			data-active-accession={activeAccession}
		>
			{children}
		</div>
	)
}

/**
 * A compact slip for the drawer: enough to recognise a record and see its
 * outcome, never so much that it competes with the consulted slip. The whole
 * card is a button, so a keyboard reaches every record.
 */
export function RecordSlipCompact({
	accession,
	channel,
	verdict,
	summary,
	decidedAt,
	onSelect,
	isActive,
}: {
	accession: string
	channel: string
	verdict: TSlipVerdict
	summary: string
	decidedAt: string
	onSelect: () => void
	isActive: boolean
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={isActive || undefined}
			className={cn(
				"record-slip w-full px-3 py-2.5 text-left transition-colors",
				SLIP_TAB[verdict],
				"hover:border-hairline-focus focus-visible:outline-2",
			)}
		>
			<div className="flex items-baseline justify-between gap-2">
				<span className="accession">{accession}</span>
				<span className="font-mono text-micro-lg text-ink-faint tabular-nums">
					{decidedAt}
				</span>
			</div>
			<p className="mt-1 truncate text-sm text-ink">
				{summary}
				<span className="mx-1.5 text-ink-faint">·</span>
				<span className="text-ink-muted">{channel}</span>
			</p>
			<p className="mt-1 text-micro-lg text-ink-muted">
				<SlipStatus verdict={verdict} />
			</p>
		</button>
	)
}

/**
 * The queue band. Its own surface, below the records, for one reason:
 * `ai_status` answers "where is this in the queue", which is a DIFFERENT
 * question from the verdict above. A member reading a `deleted` slip should
 * never have to wonder whether the number beside it is part of that decision.
 */
export function QueueBand({
	waiting,
	states,
	className,
}: {
	waiting: number
	/** Label/count pairs for every queue state, in the backend's own order. */
	states: { label: string; value: number }[]
	className?: string
}) {
	return (
		<section
			className={cn("hud-card mt-4 px-4 py-3", className)}
			aria-label="Message queue"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2 className="text-sm font-medium tracking-wide text-ink">
					Message queue
					<span className="ml-2 text-xs font-normal text-ink-muted">
						position in the queue is not a decision
					</span>
				</h2>
				<p className="metric text-lg text-ink">{waiting}</p>
			</div>
			<ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
				{states.map((state) => (
					<li key={state.label} className="flex items-baseline gap-1.5">
						<span className="field-label">{state.label}</span>
						<span className="metric text-sm text-ink-soft tabular-nums">
							{state.value}
						</span>
					</li>
				))}
			</ul>
		</section>
	)
}
