"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AreaChart } from "@/components/charts/area-activity";
import { RankedBars } from "@/components/charts/bars";
import { Avatar } from "@/components/MessageFeedCard";
import { StatGrid, StatTile } from "@/components/StatTile";
import { Section, SectionGrid } from "@/components/shared/section";
import { ErrorState } from "@/components/shared/states";
import {
  useActivity,
  useStats,
  useTopReactions,
  useTopReactors,
} from "@/hooks/use-data";
import { formatCompact, formatNumber, formatPercent } from "@/lib/format";
import type {
  DashboardActivity,
  DashboardStats,
  TopReaction,
  TopReactor,
} from "@/lib/types";
import { useWsEvent } from "@/lib/ws/context";

export function DashboardView({
  initialStats,
  initialActivity,
  initialReactions,
  initialReactors,
  days,
}: {
  initialStats: DashboardStats;
  initialActivity: DashboardActivity;
  initialReactions: TopReaction[];
  initialReactors: TopReactor[];
  days: number;
}) {
  const stats = useStats(initialStats);
  const activity = useActivity(days, initialActivity);
  const reactions = useTopReactions(10, initialReactions);
  const reactors = useTopReactors(10, initialReactors);

  // A verdict landing invalidates the headline numbers; revalidate rather than
  // poll, so a quiet system costs nothing and a busy one stays honest.
  useWsEvent("message_analyzed", () => {
    void stats.mutate();
    void activity.mutate();
  });
  useWsEvent("moderation_action", () => {
    void stats.mutate();
  });

  const daily = activity.data?.daily ?? [];
  const queue = stats.data?.moderation_overview;

  const backlogged = useMemo(
    () =>
      (queue?.pending ?? 0) + (queue?.claimed ?? 0) + (queue?.retry_wait ?? 0),
    [queue],
  );

  const chartData = useMemo(
    () =>
      daily.map((d) => ({
        label: d.day,
        value: d.messages,
        flagged: d.flagged,
      })),
    [daily],
  );

  const channelBars = useMemo(
    () =>
      (stats.data?.top_channels ?? []).map((c) => ({
        label: c.channel_name || `#${c.channel_id}`,
        value: c.message_count,
      })),
    [stats.data?.top_channels],
  );

  const flaggedRate = useMemo(() => {
    const total = stats.data?.total_messages ?? 0;
    const flagged = stats.data?.total_flagged ?? 0;
    if (total === 0) return null;
    return (flagged / total) * 100;
  }, [stats.data]);

  if (stats.error && !stats.data) {
    return (
      <ErrorState error={stats.error} onRetry={() => void stats.mutate()} />
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            Overview
          </h1>
          <p className="text-xs text-ink-muted">
            Last {days} days of activity across the monitored guild
          </p>
        </div>
      </header>

      <StatGrid cols={4}>
        <StatTile
          label="Messages"
          value={formatCompact(stats.data?.total_messages)}
          hint={`${formatNumber(stats.data?.today_messages)} today`}
        />
        <StatTile
          label="Flagged"
          value={formatCompact(stats.data?.total_flagged)}
          hint={
            flaggedRate === null
              ? undefined
              : `${formatPercent(flaggedRate, 2)} of all messages`
          }
          tone={flaggedRate !== null && flaggedRate > 2 ? "warning" : "neutral"}
        />
        <StatTile
          label="In queue"
          value={formatNumber(backlogged)}
          hint={
            queue?.dead
              ? `${formatNumber(queue.dead)} abandoned`
              : "Awaiting a verdict"
          }
          tone={backlogged > 500 ? "warning" : "neutral"}
        />
        <StatTile
          label="Active members"
          value={formatNumber(stats.data?.active_users_24h)}
          hint={`${formatNumber(stats.data?.total_users)} total`}
        />
      </StatGrid>

      <SectionGrid cols={2}>
        <Section
          title="Message volume"
          description={`Daily, last ${days} days`}
        >
          {activity.error && !activity.data ? (
            <ErrorState
              error={activity.error}
              onRetry={() => void activity.mutate()}
            />
          ) : (
            <AreaChart data={chartData} />
          )}
        </Section>

        <Section title="Busiest channels" description="All time">
          <RankedBars data={channelBars} showRank max={8} />
        </Section>
      </SectionGrid>

      <SectionGrid cols={2}>
        <Section title="Most reacted messages" description="All time">
          <RankedBars
            data={(reactions.data ?? []).map((r) => ({
              label: r.content.slice(0, 60) || `by ${r.username}`,
              value: r.reaction_count,
            }))}
            max={6}
          />
        </Section>

        <Section title="Most active reactors" description="Net reactions added">
          <ul className="space-y-2">
            {(reactors.data ?? []).map((reactor) => (
              <li key={reactor.user_id} className="flex items-center gap-2.5">
                <Avatar src={null} name={reactor.username} size={20} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                  {reactor.username}
                </span>
                <span className="reactor-count shrink-0 font-mono text-xs text-ink-muted">
                  +{formatNumber(reactor.net_count)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </SectionGrid>

      <Section
        title="Queue health"
        description="Pipeline position of every captured message"
      >
        <QueueBreakdown queue={queue} />
      </Section>
    </div>
  );
}

/**
 * Queue breakdown.
 *
 * `dead` is called out separately and in the warning tone: it is the only state
 * that means "a human needs to look at this", and folding it into "pending"
 * hides a stuck pipeline behind a healthy-looking backlog.
 */
function QueueBreakdown({
  queue,
}: {
  queue: DashboardStats["moderation_overview"] | undefined;
}) {
  if (!queue) return null;

  const rows = [
    { key: "pending", label: "Queued", value: queue.pending, tone: "neutral" },
    {
      key: "claimed",
      label: "Analyzing",
      value: queue.claimed,
      tone: "neutral",
    },
    {
      key: "retry_wait",
      label: "Retrying",
      value: queue.retry_wait,
      tone: "warning",
    },
    { key: "dead", label: "Abandoned", value: queue.dead, tone: "danger" },
    {
      key: "error",
      label: "Errored verdict",
      value: queue.error,
      tone: "warning",
    },
  ] as const;

  const hasStuck = queue.dead > 0;

  return (
    <div className="space-y-3">
      <RankedBars
        data={rows.map((r) => ({ label: r.label, value: r.value }))}
      />
      {hasStuck && (
        <p className="rounded-md border border-vermilion/30 bg-vermilion/10 px-3 py-2 text-xs text-vermilion">
          {formatNumber(queue.dead)} message
          {queue.dead === 1 ? "" : "s"} exhausted their retries and will not be
          judged automatically.{" "}
          <Link href="/messages?status=dead" className="underline">
            Review them
          </Link>
          .
        </p>
      )}
    </div>
  );
}
