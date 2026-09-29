"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type { Message } from "@/lib/types";
import type { AnalysisSearchResult } from "@/lib/types/rpc";
import { AnalysisView } from "./view";

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
      }) as Promise<AnalysisSearchResult | undefined>,
      browserApi.config.defaultGuildId(),
    ]);

    return {
      results: (initial?.results ?? []) as Message[],
      guildId,
    };
  }, []);

  const seed = useRouteSeed(fetcher);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading analysis" />;
  }

  return (
    <AnalysisView
      initialResults={seed.data.results}
      guildId={seed.data.guildId}
    />
  );
}
