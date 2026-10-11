import { useNavigate, useSearch } from "@tanstack/react-router"
import { cn } from "cn"
import { useEffect, useMemo, useState } from "react"
import { HourHeatmap, RankedBars } from "#/components/features/charts/bars"
import {
	QueueBand,
	RecordDrawer,
	RecordSlip,
	RecordSlipCompact,
	type TSlipVerdict,
} from "#/components/features/record-slip"
import { Section, SectionGrid } from "#/components/layout/section"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select"
import { EmptyState, ErrorState } from "#/components/ui/states"
import {
	useCoverage,
	useFlaggedChannels,
	useFlaggedDomains,
	useHourlyModeration,
	useModerationActions,
	useModerationStats,
	useModerationTrends,
} from "#/hooks/use-data"
import { filterFromUrl } from "#/libs/ai-status"
import {
	formatDateTime,
	formatNumber,
	formatPercent,
	humanize,
	messageBody,
	truncate,
} from "#/libs/format"
import type { ICoverage, IHourBucket, IModerationActionRow } from "#/libs/types"
import { useWsEvent } from "#/libs/ws/context"

/**
 * A Select cannot hold an empty-string value (base-ui treats "" as "no
 * selection" and renders the placeholder), so "unfiltered" gets a sentinel
 * that is mapped back to "" in state.
 */
const ANY = "__any__"

const ACTION_STATUSES = ["executed", "pending", "failed"] as const
const ACTION_TYPES = ["delete_message", "reset_nickname"] as const

/**
 * Label maps for the drawer filters. Without `items`, `<Select.Value>` prints
 * the raw item value, so the trigger showed "__any__" instead of a human label.
 */
const STATUS_ITEMS: Record<string, string> = {
	[ANY]: "Any status",
	...Object.fromEntries(ACTION_STATUSES.map((s) => [s, humanize(s)])),
}

const ACTION_ITEMS: Record<string, string> = {
	[ANY]: "Any action",
	...Object.fromEntries(ACTION_TYPES.map((t) => [t, humanize(t)])),
}

/**
 * The accession number: a record's quotable address.
 *
 * Derived from the row's own id and the time it was filed — NOT invented per
 * render, NOT a random string. The same decision must always produce the same
 * number, or quoting it back means nothing. `REC` + the filing date + the last
 * four of the id gives a member something short enough to type and stable
 * enough to be an address.
 *
 * The date is `YYYY-MM-DD` with a hyphen between every field. `20261011` reads
 * as 11 October to this UI (whose dates render `id-ID`, day-first) and as
 * October 11th to most of the world, so an address a member can quote must not
 * be ambiguous about which is which.
 *
 * `created_at` is epoch milliseconds, so the date comes from the record itself
 * rather than from `new Date()`, which would make the number drift on re-render.
 */
function accessionFor(row: IModerationActionRow): string {
	const filed = new Date(row.created_at)
	const yyyy = filed.getFullYear()
	const mm = String(filed.getMonth() + 1).padStart(2, "0")
	const dd = String(filed.getDate()).padStart(2, "0")
	return `REC ${yyyy}-${mm}-${dd}-${row.id.slice(-4).toUpperCase()}`
}

/**
 * The verdict a slip shows, derived from the ACTION row.
 *
 * The action table records what the bot DID, not what the model concluded, so
 * the mapping is not identity:
 *
 *   executed → the model called for removal and it happened  → `deleted`
 *   failed   → the model called for removal and it did NOT    → `error`
 *              happen, so nothing was removed
 *   pending  → removal called for and still queued          → `deleted`
 *
 * A `failed` row is the honest case this surface exists for: the model wanted
 * the message gone, the bot could not remove it. That is an ABSENCE, not a soft
 * delete, and it must never render as a deletion — hence `error`, which the
 * slip renders without a stamp and with its own sentence.
 *
 * NOTE: `clean` never reaches here. A kept message produces no moderation
 * action at all, so the drawer's outcome axis is removal-attempted versus not,
 * not kept-versus-deleted. Counting kept messages belongs to `by_status`, not
 * to this table.
 */
function verdictFor(row: IModerationActionRow): TSlipVerdict {
	return row.status === "failed" ? "error" : "deleted"
}

/**
 * The clause a decision was judged under.
 *
 * The row carries `categories` (the model's flagged categories) and
 * `policy_version`, but no §-number. The slip therefore names what the record
 * actually holds and nothing more — rendering a clause number the record does
 * not carry is the exact fiction PRODUCT.md forbids.
 */
function clauseFor(row: IModerationActionRow): string {
	if (row.policy_version) return `Policy ${row.policy_version}`
	if (row.categories && row.categories.length > 0) {
		return row.categories.map((c) => humanize(c)).join(", ")
	}
	return "No clause recorded"
}

/**
 * The filed decisions, as the drawer shows them: enough to recognise a record
 * and see its outcome, never so much that a drawer of twenty competes with the
 * consulted slip. Each entry is a whole button, so a keyboard reaches every
 * record.
 */
function DrawerList({
	rows,
	activeId,
	onSelect,
	filtered,
}: {
	rows: IModerationActionRow[]
	activeId: string | null
	onSelect: (id: string) => void
	/** Whether a filter is narrowing the drawer, which changes why it is empty. */
	filtered: boolean
}) {
	if (rows.length === 0) {
		return (
			<div className="hud-card px-4 py-8">
				{/*
				 * Two different emptinesses, and they must not read the same. An
				 * empty drawer because a filter excludes everything is a navigation
				 * problem; an empty drawer because no enforcement has EVER run is a
				 * fact about the record office, and it is the honest answer here —
				 * messages are kept, so no actions are filed.
				 */}
				<EmptyState
					title={
						filtered
							? "No decisions match this filter"
							: "No enforcement has been filed"
					}
					description={
						filtered
							? "Loosen the filters above to see earlier records."
							: "Messages are kept unless a rule matched one. Nothing has been removed yet."
					}
				/>
			</div>
		)
	}

	return (
		<RecordDrawer activeAccession={activeId ?? undefined}>
			{rows.map((row) => (
				<RecordSlipCompact
					key={row.id}
					accession={accessionFor(row)}
					channel={row.server_nick ? `@${row.server_nick}` : "unknown member"}
					verdict={verdictFor(row)}
					summary={
						row.content
							? truncate(messageBody(row.content), 72)
							: "No message text was captured"
					}
					decidedAt={formatDateTime(row.created_at)}
					onSelect={() => onSelect(row.id)}
					isActive={row.id === activeId}
				/>
			))}
		</RecordDrawer>
	)
}

export function ModerationView({ days }: { days: number }) {
	// Seed the drawer filters from the URL so a shared link reproduces the view,
	// and so `?status=failed` deep-links straight to the records the model could
	// not act on.
	//
	// Select state stays "" for unfiltered (the shadcn Select cannot hold an
	// empty string, so the component maps ""<->ANY at its own boundary). The URL
	// layer speaks the same dialect: validate against the allow-list, and treat
	// ANY/absent/invalid as unfiltered.
	const navigate = useNavigate()
	const urlSearch = useSearch({ from: "/_authenticated/moderation" })
	const urlStatus = filterFromUrl(urlSearch.status, ACTION_STATUSES, ANY)
	const urlAction = filterFromUrl(urlSearch.actionType, ACTION_TYPES, ANY)

	const [status, setStatus] = useState(
		urlStatus === ANY ? "" : (urlStatus as string),
	)
	const [actionType, setActionType] = useState(
		urlAction === ANY ? "" : (urlAction as string),
	)

	// Which record the reader has pulled forward out of the drawer. `null` means
	// "none chosen yet", in which case the newest record is consulted — the page
	// is never empty-handed, which is the point of the first viewport.
	const [selectedId, setSelectedId] = useState<string | null>(null)

	// Adopt a URL change made from outside this view (a back/forward navigation,
	// or a link landing on `?status=failed`). Never fight the user's own Select:
	// only overwrite when the URL actually specifies a filter.
	useEffect(() => {
		setStatus((current) =>
			urlStatus === ANY ? (current === "" ? current : "") : urlStatus,
		)
		setActionType((current) =>
			urlAction === ANY ? (current === "" ? current : "") : urlAction,
		)
	}, [urlStatus, urlAction])

	// Publish state to the URL so a reload or a shared link reproduces the view.
	// Guarded on an actual difference so a Select change does not loop.
	useEffect(() => {
		if (status === (urlStatus === ANY ? "" : urlStatus)) {
			if (actionType === (urlAction === ANY ? "" : urlAction)) return
		}
		// `replace: true` is LOAD-BEARING — see the note in messages/_components/view.tsx.
		// TanStack's `navigate` pushes by default, which would make Back walk
		// through the reader's own filtering.
		void navigate({
			to: "/moderation",
			search: (prev: Record<string, unknown>) => ({
				...prev,
				...(status ? { status } : {}),
				...(actionType ? { actionType } : {}),
			}),
			replace: true,
		})
	}, [status, actionType, urlStatus, urlAction, navigate])

	const stats = useModerationStats()
	const actions = useModerationActions(status, actionType)
	const trends = useModerationTrends(days)
	const domains = useFlaggedDomains(days)
	const flaggedChannels = useFlaggedChannels(days)
	// `IHourBucket` is the ELEMENT type; the hook returns the array of them,
	// so the generic takes `IHourBucket[]`.
	const hourly = useHourlyModeration<IHourBucket[]>(days)
	const coverage = useCoverage<ICoverage>(days)

	// An enforcement action is the terminal event for a message: refresh the
	// counters, the trends, and the drawer together so the page never shows a
	// delete the figures have not counted yet.
	useWsEvent("moderation_action", () => {
		void stats.refetch()
		void actions.refetch()
		void trends.refetch()
	})
	useWsEvent("message_analyzed", () => {
		void coverage.refetch()
	})

	const rows = useMemo(() => actions.data?.data ?? [], [actions.data?.data])

	/*
	 * The consulted record, derived rather than stored: if a refetch drops the
	 * selected row (a filter change, or newer records arriving), the selection
	 * falls back to the newest filed decision instead of rendering an empty slip
	 * beside a full drawer.
	 */
	const activeId =
		selectedId && rows.some((row) => row.id === selectedId)
			? selectedId
			: (rows[0]?.id ?? null)
	const active = rows.find((row) => row.id === activeId) ?? null

	/*
	 * The drawer holds every record EXCEPT the one being consulted. That is what
	 * "pulled forward of" means: the slip in front is the one lifted OUT, so
	 * leaving it in the drawer too would render the same record twice and make
	 * the foreground copy decoration rather than a selection.
	 *
	 * Filtering on the stable accession rather than the row object keeps the two
	 * in lockstep — the drawer and the slip derive the number the same way.
	 */
	const activeAccession = active ? accessionFor(active) : undefined
	const drawerRows = useMemo(
		() =>
			activeAccession
				? rows.filter((row) => accessionFor(row) !== activeAccession)
				: rows,
		[rows, activeAccession],
	)

	const categoryBars = useMemo(
		() =>
			(trends.data?.categories ?? []).map((c) => ({
				label: humanize(c.name),
				value: c.count,
			})),
		[trends.data?.categories],
	)

	// What the model actually did, by action type. This replaced the severity
	// distribution panel, which aggregated a column that no longer exists — the
	// backend already returns this breakdown on the same call, so the panel keeps
	// its slot rather than leaving a hole in the grid.
	const actionBars = useMemo(
		() =>
			(trends.data?.actions ?? []).map((a) => ({
				label: humanize(a.type),
				value: a.count,
			})),
		[trends.data?.actions],
	)

	// The two "model errors" figures measure DIFFERENT things, and the tile used
	// to present them as one fraction.
	//
	//   stats.data.failed      — all-time count of errored verdicts (no window)
	//   coverage.failed_rate   — failed / total WITHIN `analysis_attempts`, over
	//                           the last `days` days only
	//
	// So "1" next to "3.5% of attempts" read as 1/29 when the real denominator
	// is 4,378. The hint states the window explicitly, and falls back to the
	// windowed count when the all-time figure is zero but the window caught some.
	const errorHint = useMemo(() => {
		if (stats.data?.failed) return "All time"
		if (coverage.data?.failed) {
			return `${formatNumber(coverage.data.failed)} in ${days}d`
		}
		return "None recorded"
	}, [stats.data?.failed, coverage.data?.failed, coverage.data, days])

	/*
	 * What the headline may claim.
	 *
	 * `stats.executed` is NOT a deletion count. The repository folds every
	 * CONCLUDED verdict into it — `clean` and `deleted` alike — so a quiet week
	 * reads "27 executed" when nothing was removed at all. Verified against the
	 * live API: `executed: 27` alongside `by_status: {clean: 27, unjudged: 7}`.
	 *
	 * `by_status.deleted` is the only field that means "a message was removed",
	 * so the filing line is driven by it. The count labelled "Kept" is
	 * `by_status.clean`, which is what the field actually holds.
	 */
	const removedCount = stats.data?.by_status?.deleted ?? 0
	const keptCount = stats.data?.by_status?.clean ?? 0
	const errorCount = stats.data?.failed ?? 0

	const filingLine =
		removedCount === 0
			? keptCount === 0
				? "Nothing judged yet"
				: `${formatNumber(keptCount)} kept · nothing removed`
			: `${formatNumber(removedCount)} removed` +
				(keptCount > 0 ? ` · ${formatNumber(keptCount)} kept` : "")

	if (stats.error && !stats.data) {
		return (
			<ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
		)
	}

	return (
		<div className="space-y-4">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="font-display text-xl font-semibold tracking-tight text-ink">
						Moderation
					</h1>
					<p className="mt-0.5 text-sm text-ink-muted">
						Every decision, the rule it was judged against, and the reason
						given.
					</p>
				</div>
				<p className="text-micro-lg text-ink-faint">
					Records are public. There is no sign-in.
				</p>
			</header>

			{/*
			 * The headline is a FILING COUNT, not a four-tile KPI strip. The tiles
			 * answered "is the system healthy", which is the operator's question
			 * — but PRODUCT.md's reader is a member who arrived to ask why their
			 * message was removed. The count of decided messages is the one number
			 * that belongs to the record office, so it leads at full scale, and the
			 * supporting figures sit beside it as secondary readings rather than
			 * as four peers competing for attention.
			 */}
			<div className="hud-card flex flex-wrap items-end justify-between gap-x-8 gap-y-4 px-4 py-4">
				<div>
					<p className="field-label">Decisions on record</p>
					<p className="metric mt-1 text-4xl text-ink">
						{formatNumber(stats.data?.total)}
					</p>
					<p className="mt-1 text-xs text-ink-muted">
						{filingLine}
						{errorCount > 0
							? ` · ${formatNumber(errorCount)} could not be applied`
							: ""}
					</p>
				</div>
				<dl className="flex flex-wrap gap-x-8 gap-y-3">
					<div>
						<dt className="field-label">Kept</dt>
						<dd className="metric text-lg text-success">
							{formatNumber(keptCount)}
						</dd>
					</div>
					<div>
						<dt className="field-label">Coverage</dt>
						<dd className="metric text-lg text-ink">
							{formatPercent(coverage.data?.coverage_rate)}
						</dd>
					</div>
					<div>
						<dt className="field-label">Model errors</dt>
						<dd
							className={cn(
								"metric text-lg",
								(stats.data?.failed ?? 0) > 0 ? "text-vermilion" : "text-ink",
							)}
						>
							{formatNumber(stats.data?.failed)}
						</dd>
						<dd className="text-micro-lg text-ink-faint">{errorHint}</dd>
					</div>
				</dl>
			</div>

			{/*
			 * THE DECK — the layout the direction contract's FIRST VIEWPORT block
			 * specifies: a slip pulled forward of a drawer. Not a table with one
			 * row expanded. A table gives every record equal weight and makes the
			 * reader hunt; a slip in front of a drawer lets one record be consulted
			 * while the rest stay findable.
			 *
			 * The queue is deliberately NOT in this column group. `ai_status`
			 * answers "where is this in the queue" and `verdicts.status` answers
			 * "what was decided"; placing a queue count beside a decision is
			 * exactly how a member ends up reading "38 waiting" as "38 were
			 * removed". It gets its own band below instead.
			 */}
			{actions.error && !actions.data ? (
				<ErrorState
					error={actions.error}
					onRetry={() => void actions.refetch()}
				/>
			) : (
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<div className="min-w-0">
						{active ? (
							<RecordSlip
								accession={accessionFor(active)}
								channel={
									active.server_nick
										? `@${active.server_nick}`
										: "unknown member"
								}
								verdict={verdictFor(active)}
								reason={active.reason}
								clause={clauseFor(active)}
								evidence={active.evidence}
								confidence={active.confidence}
								// The auto-delete threshold is measured against the
								// verdict, not the action; this row does not carry it, so
								// it is passed absent rather than guessed.
								threshold={undefined}
								decidedAt={formatDateTime(active.created_at)}
								active
							/>
						) : (
							<div className="hud-card px-4 py-8">
								<EmptyState
									title="No record selected"
									description="Choose a decision from the drawer to read why it was made."
								/>
							</div>
						)}
					</div>

					<div className="min-w-0">
						<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
							<h2 className="text-sm font-medium tracking-wide text-ink">
								Filed decisions
								<span className="ml-2 text-xs font-normal text-ink-muted">
									{drawerRows.length === 0
										? "nothing else filed"
										: `${drawerRows.length} more`}
								</span>
							</h2>
							<div className="flex items-center gap-2">
								<Select
									items={STATUS_ITEMS}
									value={status || ANY}
									onValueChange={(v) => setStatus(v === ANY ? "" : (v ?? ""))}
								>
									<SelectTrigger
										size="sm"
										className="min-h-11 sm:min-h-8 w-32"
										aria-label="Status"
									>
										<SelectValue placeholder="Status" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ANY}>Any status</SelectItem>
										{ACTION_STATUSES.filter(Boolean).map((s) => (
											<SelectItem key={s} value={s}>
												{humanize(s)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>

								<Select
									items={ACTION_ITEMS}
									value={actionType || ANY}
									onValueChange={(v) =>
										setActionType(v === ANY ? "" : (v ?? ""))
									}
								>
									<SelectTrigger
										size="sm"
										className="min-h-11 sm:min-h-8 w-36"
										aria-label="Action"
									>
										<SelectValue placeholder="Action" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ANY}>Any action</SelectItem>
										{ACTION_TYPES.filter(Boolean).map((t) => (
											<SelectItem key={t} value={t}>
												{humanize(t)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<DrawerList
							rows={drawerRows}
							activeId={activeId}
							onSelect={setSelectedId}
							filtered={status !== "" || actionType !== ""}
						/>
					</div>
				</div>
			)}

			{/*
			 * The queue band. Its own surface and its own sentence, so the two
			 * questions stay visually separate: this is where a message sits in
			 * the pipeline, and nothing is deleted until it has been judged.
			 *
			 * The analytic panels sit BELOW the band, deliberately out of the first
			 * viewport. They describe the shape across many records — the operator's
			 * question — which is not what someone arrives to read.
			 */}
			<QueueBand
				waiting={stats.data?.pending ?? 0}
				states={[
					{ label: "unjudged", value: stats.data?.pending ?? 0 },
					{
						label: "coverage %",
						value: Math.round(coverage.data?.coverage_rate ?? 0),
					},
					{ label: "model errors", value: errorCount },
				]}
			/>

			<SectionGrid cols={2}>
				<Section title="Flag categories" description={`Last ${days} days`}>
					{trends.error && !trends.data ? (
						<ErrorState
							error={trends.error}
							onRetry={() => void trends.refetch()}
						/>
					) : (
						<RankedBars data={categoryBars} showRank />
					)}
				</Section>

				<Section title="Actions taken" description={`Last ${days} days`}>
					{trends.error && !trends.data ? (
						<ErrorState
							error={trends.error}
							onRetry={() => void trends.refetch()}
						/>
					) : (
						<RankedBars data={actionBars} showRank />
					)}
				</Section>
			</SectionGrid>

			<Section
				title="When moderation happens"
				description="Actions by hour of day, last 30 days"
			>
				{hourly.error && !hourly.data ? (
					<ErrorState
						error={hourly.error}
						onRetry={() => void hourly.refetch()}
					/>
				) : (
					<HourHeatmap values={hourly.data ?? []} />
				)}
			</Section>

			<SectionGrid cols={2}>
				<Section
					title="Flagged domains"
					description="Links that appeared in flagged messages"
				>
					{domains.error && !domains.data ? (
						<ErrorState
							error={domains.error}
							onRetry={() => void domains.refetch()}
						/>
					) : (
						<RankedBars
							data={(domains.data ?? []).map((d) => ({
								label: d.domain,
								value: d.count,
							}))}
							showRank
						/>
					)}
				</Section>

				<Section
					title="Most flagged channels"
					description={`Last ${days} days`}
				>
					<RankedBars
						data={(flaggedChannels.data ?? []).map((c) => ({
							label: c.channel_name || `#${c.channel_id}`,
							value: c.flagged_count,
						}))}
						showRank
					/>
				</Section>
			</SectionGrid>
		</div>
	)
}
