import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
  fetchAnalyticsOverview,
  fetchViolators,
  fetchTrend,
  fetchHeatmap,
  type AnalyticsOverview,
  type HourlyBucket,
  type TopicTrend,
  type UserStat,
  type ViolatorStat,
  type TrendBucket,
  type HeatmapCell,
} from "../api/analytics";

interface UseAnalyticsOptions {
  guildId: string;
  channelId?: string;
  hours?: number;
}

/** Shared key factory so WebSocket refresh invalidates all related queries at once. */
function analyticsKeys(guildId: string, channelId: string | undefined, hours: number) {
  return {
    overview: ["analytics", "overview", guildId, channelId ?? "", hours] as const,
    violators: ["analytics", "violators", guildId, channelId ?? "", hours] as const,
    trend: ["analytics", "trend", guildId, channelId ?? "", hours] as const,
    heatmap: ["analytics", "heatmap", guildId, channelId ?? "", hours] as const,
    all: ["analytics"] as const,
  };
}

export function useAnalytics({ guildId, channelId, hours = 24 }: UseAnalyticsOptions) {
  const queryClient = useQueryClient();
  const keys = analyticsKeys(guildId, channelId, hours);

  // ── Overview query (stale-while-revalidate) ──────────────────────────
  const overviewQuery = useQuery({
    queryKey: keys.overview,
    queryFn: () => fetchAnalyticsOverview({ guildId, channelId, hours }),
    enabled: !!guildId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // ── Violators query ──────────────────────────────────────────────────
  const violatorsQuery = useQuery({
    queryKey: keys.violators,
    queryFn: () =>
      fetchViolators({ guildId, channelId, hours, limit: 20 }),
    enabled: !!guildId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  // ── Trend query ──────────────────────────────────────────────────────
  const trendQuery = useQuery({
    queryKey: keys.trend,
    queryFn: () => fetchTrend({ guildId, channelId, hours }),
    enabled: !!guildId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  // ── Heatmap query ────────────────────────────────────────────────────
  const heatmapQuery = useQuery({
    queryKey: keys.heatmap,
    queryFn: () => fetchHeatmap({ guildId, channelId, hours }),
    enabled: !!guildId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  // ── Refresh: invalidate & refetch ────────────────────────────────────
  const refresh = useCallback(() => {
    if (!guildId) return;
    queryClient.invalidateQueries({ queryKey: keys.overview });
    queryClient.invalidateQueries({ queryKey: keys.violators });
    queryClient.invalidateQueries({ queryKey: keys.trend });
    queryClient.invalidateQueries({ queryKey: keys.heatmap });
  }, [queryClient, keys, guildId]);

  // Real-time refresh via WebSocket-triggered custom event
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("analytics_refresh", handler);
    return () => window.removeEventListener("analytics_refresh", handler);
  }, [refresh]);

  const overview = overviewQuery.data ?? null;
  const isFetching = overviewQuery.isFetching && !overviewQuery.isLoading;
  const isLoading = overviewQuery.isLoading && !overviewQuery.data;

  return {
    overview,
    isLoading,
    isFetching,
    error: overviewQuery.error instanceof Error ? overviewQuery.error.message : null,
    refresh,

    // Violators
    violators: violatorsQuery.data ?? [],
    violatorsLoading: violatorsQuery.isLoading && !violatorsQuery.data,
    violatorsFetching: violatorsQuery.isFetching && !violatorsQuery.isLoading,
    refreshViolators: () => {
      if (guildId) queryClient.invalidateQueries({ queryKey: keys.violators });
    },

    // Trend
    trend: trendQuery.data ?? [],
    trendLoading: trendQuery.isLoading && !trendQuery.data,
    trendFetching: trendQuery.isFetching && !trendQuery.isLoading,

    // Heatmap
    heatmap: heatmapQuery.data ?? [],
    heatmapLoading: heatmapQuery.isLoading && !heatmapQuery.data,
    heatmapFetching: heatmapQuery.isFetching && !heatmapQuery.isLoading,

    // Convenience accessors
    hourly: overview?.hourly ?? ([] as HourlyBucket[]),
    topics: overview?.topics ?? ([] as TopicTrend[]),
    topUsers: overview?.top_users ?? ([] as UserStat[]),
    messages: overview?.messages ?? null,
    period: overview?.period ?? null,
    activeUsersCount: overview?.active_users_count ?? 0,
    totalChannels: overview?.total_channels ?? 0,
  };
}

// Re-export for convenience
export type { AnalyticsOverview, HourlyBucket, TopicTrend, UserStat, ViolatorStat, TrendBucket, HeatmapCell };
