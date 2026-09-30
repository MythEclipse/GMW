"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { qk } from "@/hooks/use-data";
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

  // Seven hooks read seven keys; all seven are primed here so the view mounts
  // onto the seed instead of re-issuing the whole batch a frame later.
  // `actions` is keyed with the unfiltered (empty-string) status/actionType the
  // view starts on — anything else and the first render would fetch the
  // filtered table while the seed sits unused in the cache.
  const prime = useCallback(
    (r: {
      stats: ModerationStats;
      actions: ModerationActionPage;
      trends: ModerationTrends;
      domains: FlaggedDomain[];
      flaggedChannels: FlaggedChannel[];
      hourly: HourBucket[];
      coverage: Coverage;
    }) => [
      { key: qk.modStats, data: r.stats },
      { key: qk.modActions("", ""), data: r.actions },
      { key: qk.modTrends(DAYS), data: r.trends },
      { key: qk.domains(DAYS), data: r.domains },
      { key: qk.flaggedChannels(DAYS), data: r.flaggedChannels },
      { key: qk.hourly(DAYS), data: r.hourly },
      { key: qk.coverage(DAYS), data: r.coverage },
    ],
    [],
  );

  const seed = useRouteSeed(fetcher, prime);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading moderation" />;
  }

  return <ModerationView days={DAYS} />;
}
