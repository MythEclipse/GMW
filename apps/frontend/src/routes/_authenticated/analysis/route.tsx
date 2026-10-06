import { createFileRoute } from "@tanstack/react-router"

import { useCallback } from "react"
import type { AppRouterClient, InferClientOutput } from "#/api-types"
import { ErrorState, LoadingState } from "#/components/ui/states"
import { useRouteSeed } from "#/hooks/use-route-seed"
import { browserApi } from "#/libs/api/browser"
import type { IMessage } from "#/libs/types"
import { AnalysisView } from "./_components/view.tsx"

/**
 * The shape `analysis.search` actually returns, read off the backend's own
 * output schema via `InferClientOutput` rather than restated by hand — which is
 * what lets `lib/types/rpc.ts` go away.
 */
type TAnalysisSearchResult = NonNullable<
	InferClientOutput<AppRouterClient["analysis"]["search"]>
>

/**
 * Client route for /analysis — was a server component.
 *
 * The empty-query search is what gives this page content on first load, and
 * `useAnalysisSearch` deliberately issues NO request when `q` is empty (its SWR
 * key is `null`). So this seed is the only thing that fills the initial view —
 * without it the page renders its empty state until the user types, which would
 * be a behaviour change from SSR, not a pre-existing gap.
 *
 * The search is not guild-parameterised: the backend injects
 * `MONITOR_GUILD_ID` itself. `guildId` is passed through only so the view can
 * scope a query once one is typed.
 */
export function AnalysisPage() {
	const fetcher = useCallback(async () => {
		const [initial, guildId] = await Promise.all([
			browserApi.analysis.search({
				q: "",
				limit: 20,
			}) as Promise<TAnalysisSearchResult | undefined>,
			browserApi.config.defaultGuildId(),
		])

		return {
			results: (initial?.results ?? []) as IMessage[],
			guildId,
		}
	}, [])

	// `useAnalysisSearch` refuses to issue a request for an empty query, so this
	// seed is the ONLY thing that fills the first view. It has to land under the
	// empty-query key the hook reads, not under some seed-only key, or the view
	// would still render its empty state until the user typed something.
	const prime = useCallback(
		(r: { results: IMessage[]; guildId: string | null }) => [
			{
				key: ["analysis", "search", "", "*"],
				data: { results: r.results },
			},
		],
		[],
	)

	const seed = useRouteSeed(fetcher, prime)

	if (seed.error) {
		return <ErrorState error={seed.error} onRetry={seed.retry} />
	}

	if (seed.isPending || !seed.data) {
		return <LoadingState label="Loading analysis" />
	}

	return <AnalysisView guildId={seed.data.guildId} />
}

/**
 * /analysis
 *
 * The page body and the route module are one file: the old Next.js
 * `src/app/(dashboard)/<feature>/page.tsx` was folded in here when that tree was
 * retired. The view it renders sits beside this file at `_components/view.tsx`,
 * which `routeFileIgnorePattern` keeps out of the generated route tree.
 *
 * A distinct module per route gives a distinct component INSTANCE per route,
 * which is the second invariant the old `router.tsx` doc comment warned about.
 * Hoisting a page into a shared const reused across routes would make React
 * reconcile by component type, and MessagesView's local
 * guildId/channelId/search/tab state would survive navigation instead of
 * resetting.
 */
export const Route = createFileRoute("/_authenticated/analysis")({
	component: AnalysisPage,
})
