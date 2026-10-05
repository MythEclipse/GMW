"use client"

import type { AppRouterClient, InferClientOutput } from "@api/api-types"
import { useEffect, useState } from "react"
import { MessageFeedCard } from "@/components/MessageFeedCard"
import { Section } from "@/components/shared/section"
import {
	EmptyState,
	ErrorState,
	NoResultsState,
} from "@/components/shared/states"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAnalysisSearch } from "@/hooks/use-data"
import { useDebounced } from "@/hooks/use-debounced"
import { isPipelineStatus, isVerdictStatus } from "@/lib/ai-status"
import { formatRelative, truncate } from "@/lib/format"

/**
 * The shape `analysis.search` actually returns, read off the backend's own
 * output schema via `InferClientOutput` rather than restated by hand — which is
 * what lets `lib/types/rpc.ts` go away.
 */
type AnalysisSearchResult = NonNullable<
	InferClientOutput<AppRouterClient["analysis"]["search"]>
>

export function AnalysisView({ guildId }: { guildId: string | null }) {
	const [input, setInput] = useState("")
	const [committed, setCommitted] = useState("")
	// Debounced so typing does not fire a request per keystroke; the input stays
	// responsive and the list updates a beat behind.
	const debounced = useDebounced(committed, 300)

	useEffect(() => {
		setCommitted(input.trim())
	}, [input])

	const search = useAnalysisSearch<AnalysisSearchResult>(
		debounced,
		guildId ?? undefined,
	)

	const results = search.data?.results ?? []
	const isSearching = debounced !== committed

	return (
		<div className="space-y-4">
			<header>
				<h1 className="font-display text-xl font-semibold tracking-tight text-ink">
					Analysis
				</h1>
				<p className="text-xs text-ink-muted">
					Search captured messages and read what the model concluded about them
				</p>
			</header>

			<form
				className="flex items-center gap-2"
				onSubmit={(event) => {
					event.preventDefault()
					setCommitted(input.trim())
				}}
			>
				<Input
					value={input}
					onChange={(event) => setInput(event.target.value)}
					placeholder="Search message text…"
					aria-label="Search messages"
					className="w-full sm:w-96"
				/>
				<Button type="submit" variant="outline" size="sm">
					Search
				</Button>
				{debounced && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setInput("")}
					>
						Clear
					</Button>
				)}
			</form>

			{search.error && !search.data ? (
				<ErrorState
					error={search.error}
					onRetry={() => void search.refetch()}
				/>
			) : results.length === 0 ? (
				debounced ? (
					<NoResultsState query={debounced} />
				) : (
					<EmptyState
						title="No analysed messages yet"
						description="Results appear as the worker finishes judging captured messages."
					/>
				)
			) : (
				<Section
					title={
						debounced
							? `${results.length} results for “${truncate(debounced, 40)}”`
							: `${results.length} most recent`
					}
					bodyClassName="p-0"
				>
					<ul
						className="divide-y divide-hairline"
						aria-busy={search.isFetching || isSearching || undefined}
					>
						{results.map((message) => (
							<li key={message.id} className="px-3 py-2.5">
								<MessageFeedCard
									message={{
										...message,
										// The API types these as plain strings; the card wants the
										// PipelineStatus / VerdictStatus unions. The guards in
										// @/lib/ai-status exist for exactly this narrowing.
										ai_status: isPipelineStatus(message.ai_status)
											? message.ai_status
											: null,
										verdict_status: isVerdictStatus(message.verdict_status)
											? message.verdict_status
											: null,
										// The API types this as `unknown` (jsonb). The card wants
										// string[]; anything else is not evidence it can render.
										verdict_evidence: Array.isArray(message.verdict_evidence)
											? (message.verdict_evidence as string[])
											: null,
									}}
								/>
								<p className="mt-1 pl-1 font-mono text-micro text-ink-faint">
									{formatRelative(message.created_at)} · channel{" "}
									{message.channel_id}
								</p>
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	)
}
