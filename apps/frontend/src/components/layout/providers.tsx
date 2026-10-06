import { QueryClientProvider } from "@tanstack/react-query"
import { Outlet } from "@tanstack/react-router"
import { getQueryClient } from "#/libs/query-client"
import { WsProvider } from "#/libs/ws/context"

/**
 * Root-route providers: the query cache and the `/ws` socket.
 *
 * Deliberately slim. Chrome (topbar, nav rail, chatbot, palette) lives one layer
 * down in `#/components/layout/shell`, mounted by the `_authenticated` layout —
 * see that file for why it moved.
 *
 * WHAT MUST STAY HERE, and why the split is safe:
 *
 *  - `QueryClientProvider` and `WsProvider` sit ABOVE `<Outlet />`, so a route
 *    element mounted through the outlet can read the cache and subscribe to
 *    socket events.
 *  - Both are on the ROOT route, which by definition never unmounts during
 *    navigation. That is what keeps the `/ws` socket open across route changes —
 *    the invariant the pre-split `Providers` comment guarded, preserved here by
 *    construction rather than by discipline.
 *  - The browser singleton comes from `getQueryClient()`, so calling it on every
 *    render is free; it does not construct a second cache.
 */
export function Providers() {
	const queryClient = getQueryClient()

	return (
		<QueryClientProvider client={queryClient}>
			<WsProvider>
				<Outlet />
			</WsProvider>
		</QueryClientProvider>
	)
}
