import { QueryClient } from "@tanstack/react-query"

/**
 * The single QueryClient for the dashboard.
 *
 * WHY ONE CLIENT AND NOT PER-ROUTE CLIENTS
 *
 * The review queue, the feed and the edit log all show the same underlying
 * messages, and a `/ws` event for one has to be able to refresh the others.
 * Separate clients would mean separate caches: a verdict arriving over the
 * socket could refresh the feed while the review queue kept serving a stale copy
 * from a cache nobody else can reach. One client, one cache, prefix
 * invalidation — the reason structured query keys are worth the extra typing.
 *
 * WHY `staleTime` IS NOT ZERO
 *
 * A zero staleTime means every mount of a route refetches, which is how this app
 * behaved under SWR. But each route seeds its own first paint through
 * `useRouteSeed`, so a mount-time refetch duplicates a request that just
 * succeeded milliseconds earlier. 5s covers that gap without making genuinely
 * live data feel stale, because live data is invalidated by the socket anyway —
 * staleness and freshness are different problems.
 */
export function makeQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 5_000,
				gcTime: 5 * 60_000,
				refetchOnWindowFocus: false,
				refetchOnReconnect: true,
				retry: 3,
				// Bounded exponential backoff: 1s, 2s, 4s. Long enough to ride out a
				// gateway blip, short enough that a genuinely bad request does not feel
				// hung for twenty seconds.
				retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
			},
			mutations: {
				// Panel-level acknowledgements (approve, dismiss). They must not vanish
				// because a refetch landed.
				retry: 0,
			},
		},
	})
}

let browserClient: QueryClient | undefined

/** Client-only app (no SSR), so there is exactly one client lifetime. */
export function getQueryClient(): QueryClient {
	browserClient ??= makeQueryClient()
	return browserClient
}
