import { createFileRoute } from "@tanstack/react-router"

import { useCallback } from "react"
import { ErrorState, LoadingState } from "#/components/ui/states"
import { qk } from "#/hooks/use-data"
import { useRouteSeed } from "#/hooks/use-route-seed"
import { browserApi } from "#/libs/api/browser"
import type { IUserPage } from "#/libs/types"
import { UsersView } from "./_components/view.tsx"

/**
 * Client route for /users — was a server component fetching via
 * `getUsers({ limit: 30 })`. Same fetch, same `data` projection into the view's
 * `initialUsers` prop.
 */
export function UsersPage() {
	const fetcher = useCallback(async () => {
		const users = (await browserApi.dashboard.users({
			limit: 30,
		})) as unknown as IUserPage
		return { users }
	}, [])

	const prime = useCallback(
		(r: { users: IUserPage }) => [{ key: qk.users(""), data: r.users }],
		[],
	)

	const seed = useRouteSeed(fetcher, prime)

	if (seed.error) {
		return <ErrorState error={seed.error} onRetry={seed.retry} />
	}

	if (seed.isPending || !seed.data) {
		return <LoadingState label="Loading members" />
	}

	return <UsersView />
}

/**
 * /users
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
export const Route = createFileRoute("/_authenticated/users")({
	component: UsersPage,
})
