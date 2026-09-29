"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client-side replacement for the SSR data seed.
 *
 * Every `page.tsx` used to be an async React Server Component: it awaited
 * `@/lib/api/server` fetches, and the view rendered with that data already in
 * hand — no spinner, no em-dashes. With SSR gone, something has to fetch on the
 * client and hold the render until it lands. That something is this hook.
 *
 * WHY BLOCK RATHER THAN SWR `fallbackData`
 *
 * The obvious alternative is to drop `initialData` to `undefined` and let the
 * existing SWR hooks fetch on mount. That renders a page that looks *working*
 * but is empty, because:
 *
 *  - `src/lib/format.ts` returns "—" for every null/undefined number, so
 *    `formatNumber(undefined)` paints an em-dash, not a spinner.
 *  - `src/components/shared/states.tsx` exports `LoadingState` and NOTHING
 *    imports it — today there is no loading affordance anywhere in the app.
 *  - Seven hooks set `keepPreviousData: true`, so an empty cache stays
 *    `data === undefined` rather than flipping to a placeholder.
 *
 * The result of that path is a dashboard full of em-dashes reading "No
 * messages match these filters" — indistinguishable from a healthy-but-quiet
 * guild. Blocking the route render until the seed resolves preserves the exact
 * contract the views were written against, and finally gives `LoadingState` the
 * consumer it was written for.
 *
 * REVALIDATION IS NOT AFFECTED
 *
 * This only covers the FIRST load of a route. Once the view mounts, its SWR
 * hooks own everything after that — including the `useWsEvent` revalidations on
 * `message_analyzed` / `moderation_action`. Do not add a poll here: polling the
 * same data the `/ws` socket already pushes is what previously produced a
 * review queue showing stale verdicts.
 */
export interface RouteSeed<T> {
  data: T | null;
  error: Error | null;
  isPending: boolean;
  /** Re-run the fetcher. Used by the ErrorState retry affordance. */
  retry: () => void;
}

/**
 * Runs `fetcher` once per route mount (and again on `retry`), exposing its
 * lifecycle so the route can render Loading → content, or Error → content.
 *
 * `fetcher` is captured in a ref, so it may be an inline arrow without
 * re-firing the seed on every render of the route.
 */
export function useRouteSeed<T>(fetcher: () => Promise<T>): RouteSeed<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(true);

  // Bumped by retry() to force the effect to re-run. State, not a ref —
  // bumping a ref would not re-render, so the effect would never re-fire
  // and retry would silently do nothing.
  const [attempt, setAttempt] = useState(0);
  // Guards against a slow first fetch resolving after a retry already
  // succeeded and overwriting the newer value with a stale one.
  const latest = useRef(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // `attempt` is an intentional fire-on-bump trigger (read by React's dep
  // comparison, not by the body). `fetcher` is intentionally NOT a dep — it
  // is captured in a ref so an inline arrow in the route does not re-fire
  // the seed per render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explained above
  useEffect(() => {
    const ticket = ++latest.current;
    let cancelled = false;

    setIsPending(true);
    setError(null);

    fetcherRef
      .current()
      .then((result) => {
        if (cancelled || ticket !== latest.current) return;
        setData(result);
        setIsPending(false);
      })
      .catch((err: unknown) => {
        if (cancelled || ticket !== latest.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { data, error, isPending, retry };
}
