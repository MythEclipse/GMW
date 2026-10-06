import { createFileRoute } from "@tanstack/react-router"

import { useCallback } from "react"
import { ErrorState, LoadingState } from "#/components/ui/states"
import { qk } from "#/hooks/use-data"
import { useRouteSeed } from "#/hooks/use-route-seed"
import { browserApi } from "#/libs/api/browser"
import type { IChannelPage, IGuild } from "#/libs/types"
import { ChannelsView } from "./_components/view.tsx"

/**
 * Client route for /channels — was a server component.
 *
 * GUILD SCOPING IS NOT A DISPLAY DETAIL
 *
 * The server version computed `scopedGuildId` as
 * `defaultGuildId ?? guilds[0]?.id ?? null` and passed it to the view, which
 * forwards it to `useChannels`. Scoping to the monitored guild keeps the list
 * to channels this deployment actually watches; without it the page lists every
 * guild in the archive — a silently wrong result, not an error. That
 * computation is reproduced here, including the precedence order.
 *
 * The `limit` of 50 matches the old server call. `useChannels` defaults to 20
 * on its own revalidation, which would shrink the list right after first
 * paint — that mismatch predates this migration and is left alone.
 */
export function ChannelsPage() {
	const fetcher = useCallback(async () => {
		const [guilds, defaultGuildId] = await Promise.all([
			browserApi.messages.guilds() as Promise<IGuild[]>,
			browserApi.config.defaultGuildId(),
		])

		const scopedGuildId = defaultGuildId ?? guilds?.[0]?.id ?? null

		const channels = (await browserApi.dashboard.channels({
			limit: 50,
			...(scopedGuildId ? { guildId: scopedGuildId } : {}),
		})) as unknown as IChannelPage

		// The whole `IChannelPage` is seeded, not just `.data`: the hook reads
		// `nextCursor` too, and handing it a page-shaped object with no cursor
		// would silently read as "this is the last page".
		return { channels, scopedGuildId }
	}, [])

	const prime = useCallback(
		(r: { channels: IChannelPage; scopedGuildId: string | null }) => [
			{
				key: [...qk.channels(""), r.scopedGuildId ?? "*"],
				data: r.channels,
			},
		],
		[],
	)

	const seed = useRouteSeed(fetcher, prime)

	if (seed.error) {
		return <ErrorState error={seed.error} onRetry={seed.retry} />
	}

	if (seed.isPending || !seed.data) {
		return <LoadingState label="Loading channels" />
	}

	return <ChannelsView scopedGuildId={seed.data.scopedGuildId} />
}

/**
 * /channels
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
export const Route = createFileRoute("/_authenticated/channels")({
	component: ChannelsPage,
})
