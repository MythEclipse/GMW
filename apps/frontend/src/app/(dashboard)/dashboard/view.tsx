"use client";

import { Link } from "@tanstack/react-router";
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
import {
  formatCompact,
  formatNumber,
  formatPercent,
  messageLabel,
} from "@/lib/format";
import type { DashboardStats } from "@/lib/types";
import { useWsEvent } from "@/lib/ws/context";

export function DashboardView({ days }: { days: number }) {
  const stats = useStats();
  const activity = useActivity(days);
  const reactions = useTopReactions(10);
  const reactors = useTopReactors(10);

  // A verdict landing invalidates the headline numbers; revalidate rather than
  // poll, so a quiet system costs nothing and a busy one stays honest.
  useWsEvent("message_analyzed", () => {
    void stats.refetch();
    void activity.refetch();
  });
  useWsEvent("moderation_action", () => {
    void stats.refetch();
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
      <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
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
          exact={formatNumber(stats.data?.total_messages)}
          hint={`${formatNumber(stats.data?.today_messages)} today`}
          to="/messages"
        />
        <StatTile
          label="Deleted"
          value={formatCompact(stats.data?.total_flagged)}
          hint={
            flaggedRate === null
              ? undefined
              : `${formatPercent(flaggedRate, 2)} of all messages`
          }
          tone={flaggedRate !== null && flaggedRate > 2 ? "warning" : "neutral"}
          to="/messages?verdict=deleted"
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
          to="/messages?status=pending"
        />
        <StatTile
          label="Active members"
          value={formatNumber(stats.data?.active_users_24h)}
          hint={`${formatNumber(stats.data?.total_users)} total`}
          to="/users"
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
              onRetry={() => void activity.refetch()}
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
            data={(reactions.data ?? []).map((r) => {
              // A custom-emoji-only message has no readable text, so the label
              // falls back to the author instead of rendering the raw
              // `<:adobe:1520373128566411417>` token as the row's whole identity.
              const text = messageLabel(r.content, 60);
              return {
                label: text || `Reaction from ${r.username}`,
                value: r.reaction_count,
              };
            })}
            max={6}
          />
        </Section>

        {/*
          The description names the DIRECTION and the netting, because
          "net reactions added" said neither. `net_count` is
          `add_count - remove_count` on `message_reactions` rows, and every
          such row is a reaction this user gave — so the old label could be read
          as reactions this user *received*, which is the opposite panel
          ("Most reacted messages"). "Reactions they gave, adds minus removes"
          is longer, but it is the only reading that is correct.
        */}
        <Section
          title="Most active reactors"
          description="Reactions they gave, adds minus removes"
        >
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
 * that means "the worker gave up and nobody will ever judge this", and folding
 * it into "pending" hides a stuck pipeline behind a healthy-looking backlog.
 * Nothing here waits on a person — the pipeline is full-auto — so this is a
 * health signal, not a work queue.
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
      key: "skipped",
      // Terminal like `analyzed`, so the list order puts it last. Not an
      // alert: the channel is exempt on purpose.
      label: "Not moderated",
      value: queue.skipped,
      tone: "neutral",
    },
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
          <Link to="/messages?status=dead" className="underline">
            Inspect them
          </Link>
          .
        </p>
      )}
    </div>
  );
}
