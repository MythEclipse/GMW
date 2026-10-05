"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Client-side replacement for the SSR data seed.
 *
 * Every `page.tsx` used to be an async React Server Component: it awaited
 * `@/lib/api/server` fetches, and the view rendered with that data already in
 * hand — no spinner, no em-dashes. With SSR gone, something has to fetch on the
 * client and hold the render until it lands. That something is this hook.
 *
 * WHY BLOCK RATHER THAN RENDER EMPTY
 *
 * The obvious alternative is to let the query hooks fetch on mount and render
 * whatever is there. That renders a page that looks *working* but is empty,
 * because:
 *
 *  - `src/lib/format.ts` returns "—" for every null/undefined number, so
 *    `formatNumber(undefined)` paints an em-dash, not a spinner.
 *  - `src/components/shared/states.tsx` exports `LoadingState` and NOTHING
 *    imported it — there was no loading affordance anywhere in the app.
 *
 * The result of that path is a dashboard full of em-dashes reading "No
 * messages match these filters" — indistinguishable from a healthy-but-quiet
 * guild. Blocking the route render until the seed resolves preserves the exact
 * contract the views were written against.
 *
 * WHY `seed` WRITES INTO THE QUERY CACHE
 *
 * Under SWR the seed's result was threaded into every hook as `fallbackData`,
 * so the route and the hook each held a copy of the same rows. With Query there
 * is one cache, and a route that fetches without seeding it throws that fetch
 * away: the route's fetch, then the hook's identical fetch a frame later, for
 * the same 50 rows. `seed` writes the result under the exact key the view will
 * read, so the hook mounts onto data that is already there.
 *
 * This is also why the views can drop their `initialStats` / `initialMessages`
 * props entirely: there is one copy of the data, in one place, and it is the
 * cache the view already reads.
 *
 * REVALIDATION IS NOT AFFECTED
 *
 * This only covers the FIRST load of a route. Once the view mounts, its query
 * hooks own everything after that — including the `useWsEvent` invalidations on
 * `message_analyzed` / `moderation_action`. Do not add a poll here: polling the
 * same data the `/ws` socket already pushes is what previously produced a
 * review queue showing stale verdicts.
 */
export interface RouteSeed<T> {
	data: T | null
	error: Error | null
	isPending: boolean
	/** Re-run the fetcher. Used by the ErrorState retry affordance. */
	retry: () => void
}

/** One cache entry to prime: the key the view will read, and the data for it. */
export interface SeedEntry<T> {
	key: readonly unknown[]
	data: T
}

/**
 * Runs `fetcher` once per route mount (and again on `retry`), exposing its
 * lifecycle so the route can render Loading → content, or Error → content.
 *
 * `seed` is optional: pass it to prime the query cache with the fetched result
 * so the view does not re-fetch the same rows on mount.
 *
 * Both `fetcher` and `seed` are captured in refs, so they may be inline arrows
 * without re-firing the seed on every render of the route.
 */
export function useRouteSeed<T>(
	fetcher: () => Promise<T>,
	seed?: (result: T) => SeedEntry<unknown>[],
): RouteSeed<T> {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState<Error | null>(null)
	const [isPending, setIsPending] = useState(true)

	const queryClient = useQueryClient()

	// Bumped by retry() to force the effect to re-run. State, not a ref —
	// bumping a ref would not re-render, so the effect would never re-fire
	// and retry would silently do nothing.
	const [attempt, setAttempt] = useState(0)
	// Guards against a slow first fetch resolving after a retry already
	// succeeded and overwriting the newer value with a stale one.
	const latest = useRef(0)

	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher
	const seedRef = useRef(seed)
	seedRef.current = seed

	// `attempt` is an intentional fire-on-bump trigger (read by React's dep
	// comparison, not by the body). `fetcher` is intentionally NOT a dep — it
	// is captured in a ref so an inline arrow in the route does not re-fire
	// the seed per render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: explained above
	useEffect(() => {
		const ticket = ++latest.current
		let cancelled = false

		setIsPending(true)
		setError(null)

		fetcherRef
			.current()
			.then((result) => {
				if (cancelled || ticket !== latest.current) return
				// Prime the cache BEFORE flipping isPending, so the view's first render
				// already finds its data and does not flash an empty list.
				const entries = seedRef.current?.(result)
				if (entries) {
					for (const entry of entries) {
						queryClient.setQueryData(entry.key, entry.data)
					}
				}
				setData(result)
				setIsPending(false)
			})
			.catch((err: unknown) => {
				if (cancelled || ticket !== latest.current) return
				setError(err instanceof Error ? err : new Error(String(err)))
				setIsPending(false)
			})

		return () => {
			cancelled = true
		}
		// `queryClient` is the provider's stable singleton, so it is not a dep.
		// biome-ignore lint/correctness/useExhaustiveDependencies: explained above
	}, [attempt])

	const retry = useCallback(() => {
		setAttempt((n) => n + 1)
	}, [])

	return { data, error, isPending, retry }
}
