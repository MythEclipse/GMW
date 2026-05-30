import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAnalyticsOverview, type AnalyticsOverview, type HourlyBucket, type TopicTrend, type UserStat } from "../api/analytics";

interface UseAnalyticsOptions {
  guildId: string;
  channelId?: string;
  hours?: number;
  autoRefresh?: boolean;
  refreshIntervalMs?: number;
}

export function useAnalytics({ guildId, channelId, hours = 24, autoRefresh = true, refreshIntervalMs = 5_000 }: UseAnalyticsOptions) {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!guildId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAnalyticsOverview({ guildId, channelId, hours });
      setOverview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [guildId, channelId, hours]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh on interval
  useEffect(() => {
    if (!autoRefresh || !guildId) return;
    intervalRef.current = setInterval(load, refreshIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load, autoRefresh, refreshIntervalMs, guildId]);

  // Real-time refresh via WebSocket-triggered custom event
  useEffect(() => {
    const handler = () => load();
    window.addEventListener("analytics_refresh", handler);
    return () => window.removeEventListener("analytics_refresh", handler);
  }, [load]);

  return {
    overview,
    loading,
    error,
    refresh: load,
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
