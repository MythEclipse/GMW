"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { qk } from "@/hooks/use-data";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type {
  DashboardActivity,
  DashboardStats,
  TopReaction,
  TopReactor,
} from "@/lib/types";
import { DashboardView } from "./view";

const DAYS = 14;

/**
 * Client route for /dashboard — was an async React Server Component that
 * fetched its seed from `@/lib/api/server` at render time.
 *
 * The fetch list, the parallel Promise.all, and the props handed to the view
 * are unchanged; only the transport and the timing moved. `useRouteSeed` holds
 * the render until all four resolve, so `DashboardView` still receives real
 * numbers on its first render exactly as it did under SSR.
 */
export function DashboardPage() {
  const fetcher = useCallback(async () => {
    // Independent reads, so they go in parallel rather than in sequence.
    const [stats, activity, reactions, reactors] = await Promise.all([
      browserApi.dashboard.stats(),
      browserApi.dashboard.activity(DAYS),
      browserApi.dashboard.reactions(10),
      browserApi.dashboard.reactors(10),
    ]);

    return {
      stats: stats as unknown as DashboardStats,
      activity: activity as unknown as DashboardActivity,
      reactions: reactions as unknown as TopReaction[],
      reactors: reactors as unknown as TopReactor[],
    };
  }, []);

  // Prime the cache under the exact keys `useStats` / `useActivity` /
  // `useTopReactions` / `useTopReactors` read, so those hooks mount onto this
  // data instead of firing four identical requests one frame later.
  const prime = useCallback(
    (r: {
      stats: DashboardStats;
      activity: DashboardActivity;
      reactions: TopReaction[];
      reactors: TopReactor[];
    }) => [
      { key: qk.stats, data: r.stats },
      { key: qk.activity(DAYS), data: r.activity },
      { key: qk.reactions(10), data: r.reactions },
      { key: qk.reactors(10), data: r.reactors },
    ],
    [],
  );

  const seed = useRouteSeed(fetcher, prime);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading overview" />;
  }

  return <DashboardView days={DAYS} />;
}
