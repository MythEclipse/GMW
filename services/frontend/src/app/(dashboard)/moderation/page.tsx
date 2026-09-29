"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type {
  Coverage,
  FlaggedChannel,
  FlaggedDomain,
  HourBucket,
  ModerationActionPage,
  ModerationStats,
  ModerationTrends,
} from "@/lib/types";
import { ModerationView } from "./view";

const DAYS = 30;

/**
 * Client route for /moderation — was a server component issuing seven parallel
 * oRPC calls. The `Promise.all` and every prop are unchanged.
 */
export function ModerationPage() {
  const fetcher = useCallback(async () => {
    const [stats, actions, trends, domains, flaggedChannels, hourly, coverage] =
      await Promise.all([
        browserApi.moderation.stats() as unknown as Promise<ModerationStats>,
        browserApi.moderation.actions({
          limit: 50,
        }) as unknown as Promise<ModerationActionPage>,
        browserApi.moderation.trends(
          DAYS,
        ) as unknown as Promise<ModerationTrends>,
        browserApi.moderation.topDomains(DAYS) as unknown as Promise<
          FlaggedDomain[]
        >,
        browserApi.moderation.topChannels(DAYS) as unknown as Promise<
          FlaggedChannel[]
        >,
        browserApi.moderation.byHour(DAYS) as unknown as Promise<HourBucket[]>,
        browserApi.moderation.coverage(DAYS) as unknown as Promise<Coverage>,
      ]);

    return {
      stats,
      actions,
      trends,
      domains: domains ?? [],
      flaggedChannels: flaggedChannels ?? [],
      hourly: hourly ?? [],
      coverage,
    };
  }, []);

  const seed = useRouteSeed(fetcher);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading moderation" />;
  }

  return (
    <ModerationView
      initialStats={seed.data.stats}
      initialActions={seed.data.actions}
      initialTrends={seed.data.trends}
      initialDomains={seed.data.domains}
      initialFlaggedChannels={seed.data.flaggedChannels}
      initialHourly={seed.data.hourly}
      initialCoverage={seed.data.coverage}
      days={DAYS}
    />
  );
}
