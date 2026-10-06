import { useState } from "react"
import { RankedBars } from "#/components/features/charts/bars"
import { Markdown } from "#/components/features/markdown"
import { Section, SectionGrid } from "#/components/layout/section"
import { Input } from "#/components/ui/input"
import { EmptyState, ErrorState, NoResultsState } from "#/components/ui/states"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { Badge } from "#/components/ui/tone"
import {
	useChannelCultures,
	useFlaggedDomains,
	useGlossary,
} from "#/hooks/use-data"
import { formatNumber, formatRelative, humanize } from "#/libs/format"
import type { IChannelCulture, IGlossaryTerm } from "#/libs/types"

const DAYS = 30

/**
 * The three "what does this community actually mean" surfaces: channel
 * cultures, the term glossary, and the domains that show up in flagged
 * messages. All three are read-only reference data, so they share one page.
 */
export function GlossaryView() {
	const [search, setSearch] = useState("")

	const cultures = useChannelCultures(search)
	const glossary = useGlossary(search)
	const domains = useFlaggedDomains(DAYS)

	return (
		<div className="space-y-4">
			<header>
				<h1 className="font-display text-xl font-semibold tracking-tight text-ink">
					Glossary
				</h1>
				<p className="text-xs text-ink-muted">
					Channel culture, community slang, and the domains behind flagged links
				</p>
			</header>

			<Input
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				placeholder="Filter…"
				aria-label="Filter glossary"
				className="w-full sm:w-72"
			/>

			<Tabs defaultValue="culture">
				<TabsList className="tabs-touch">
					<TabsTrigger value="culture">Channel culture</TabsTrigger>
					<TabsTrigger value="terms">Terms</TabsTrigger>
					<TabsTrigger value="domains">Flagged domains</TabsTrigger>
				</TabsList>

				<TabsContent value="culture" className="mt-4">
					<CultureList
						cultures={cultures.data ?? []}
						loading={cultures.isFetching}
						error={cultures.error}
						onRetry={() => void cultures.refetch()}
						search={search}
					/>
				</TabsContent>

				<TabsContent value="terms" className="mt-4">
					<TermList
						terms={glossary.data ?? []}
						loading={glossary.isFetching}
						error={glossary.error}
						onRetry={() => void glossary.refetch()}
						search={search}
					/>
				</TabsContent>

				<TabsContent value="domains" className="mt-4">
					<SectionGrid cols={2}>
						<Section
							title="Flagged domains"
							description={`Links seen in flagged messages, last ${DAYS} days`}
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

						<Section title="Reading the list">
							<p className="text-sm text-ink-muted">
								A domain here is not proof of a scam — it is simply a host that
								appeared in a message the model flagged. Discord's own CDN and
								common link shorteners show up here too, because a flagged
								message can link to anything.
							</p>
						</Section>
					</SectionGrid>
				</TabsContent>
			</Tabs>
		</div>
	)
}

function CultureList({
	cultures,
	loading,
	error,
	onRetry,
	search,
}: {
	cultures: IChannelCulture[]
	loading: boolean
	error: unknown
	onRetry: () => void
	search: string
}) {
	if (error && cultures.length === 0) {
		return <ErrorState error={error} onRetry={onRetry} />
	}
	if (cultures.length === 0) {
		return search ? (
			<NoResultsState query={search} />
		) : (
			<EmptyState title="No channel cultures analysed yet" />
		)
	}

	return (
		<ul className="space-y-2" aria-busy={loading || undefined}>
			{cultures.map((culture) => (
				<li key={culture.channel_id} className="hud-card px-4 py-3">
					<h2 className="truncate text-sm font-medium text-ink">
						{culture.channel_name || `#${culture.channel_id}`}
					</h2>
					<div className="mt-2 border-l-2 border-hairline pl-3">
						<Markdown compact>{culture.culture_summary}</Markdown>
					</div>
				</li>
			))}
		</ul>
	)
}

function TermList({
	terms,
	loading,
	error,
	onRetry,
	search,
}: {
	terms: IGlossaryTerm[]
	loading: boolean
	error: unknown
	onRetry: () => void
	search: string
}) {
	if (error && terms.length === 0) {
		return <ErrorState error={error} onRetry={onRetry} />
	}
	if (terms.length === 0) {
		return search ? (
			<NoResultsState query={search} />
		) : (
			<EmptyState
				title="No terms cached yet"
				description="Terms are resolved as the model encounters unfamiliar words."
			/>
		)
	}

	return (
		<Section title={`${formatNumber(terms.length)} terms`} bodyClassName="p-0">
			<ul className="divide-y divide-hairline" aria-busy={loading || undefined}>
				{terms.map((term) => (
					<li key={term.term} className="glossary-entry px-4 py-3">
						<div className="flex flex-wrap items-baseline gap-2">
							<span className="font-mono text-sm text-ink">{term.term}</span>
							<Badge tone="neutral">hit {formatNumber(term.hit_count)}×</Badge>
							<span className="ml-auto font-mono text-micro text-ink-faint">
								{formatRelative(term.resolved_at)}
							</span>
						</div>
						<p className="mt-1.5 text-sm text-ink-soft">{term.definition}</p>
						{term.source_url && (
							<a
								href={term.source_url}
								target="_blank"
								rel="noopener noreferrer"
								className="mt-1 inline-block text-xs text-signal underline underline-offset-2"
							>
								{humanize(new URL(term.source_url).hostname)}
							</a>
						)}
					</li>
				))}
			</ul>
		</Section>
	)
}
