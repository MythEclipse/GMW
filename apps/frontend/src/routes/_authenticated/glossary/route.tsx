import { createFileRoute } from "@tanstack/react-router"

import { useCallback } from "react"
import { ErrorState, LoadingState } from "#/components/ui/states"
import { qk } from "#/hooks/use-data"
import { useRouteSeed } from "#/hooks/use-route-seed"
import { browserApi } from "#/libs/api/browser"
import type {
	IChannelCulture,
	IFlaggedDomain,
	IGlossaryTerm,
} from "#/libs/types"
import { GlossaryView } from "./_components/view.tsx"

const DAYS = 30

/**
 * Client route for /glossary — was a server component issuing three parallel
 * oRPC calls. IProps unchanged.
 */
export function GlossaryPage() {
	const fetcher = useCallback(async () => {
		const [cultures, glossary, domains] = await Promise.all([
			browserApi.knowledge.channelCultures({
				limit: 50,
			}) as unknown as Promise<IChannelCulture[]>,
			browserApi.knowledge.glossary({
				limit: 50,
			}) as unknown as Promise<IGlossaryTerm[]>,
			browserApi.moderation.topDomains(DAYS) as unknown as Promise<
				IFlaggedDomain[]
			>,
		])

		return {
			cultures: cultures ?? [],
			glossary: glossary ?? [],
			domains: domains ?? [],
		}
	}, [])

	const prime = useCallback(
		(r: {
			cultures: IChannelCulture[]
			glossary: IGlossaryTerm[]
			domains: IFlaggedDomain[]
		}) => [
			{ key: qk.cultures(""), data: r.cultures },
			{ key: qk.glossary(""), data: r.glossary },
			{ key: qk.domains(DAYS), data: r.domains },
		],
		[],
	)

	const seed = useRouteSeed(fetcher, prime)

	if (seed.error) {
		return <ErrorState error={seed.error} onRetry={seed.retry} />
	}

	if (seed.isPending || !seed.data) {
		return <LoadingState label="Loading glossary" />
	}

	return <GlossaryView />
}

/**
 * /glossary
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
export const Route = createFileRoute("/_authenticated/glossary")({
	component: GlossaryPage,
})
