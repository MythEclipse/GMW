"use client";

import { useMemo, useState } from "react";
import { Markdown } from "@/components/shared/markdown";
import {
  EmptyState,
  ErrorState,
  NoResultsState,
} from "@/components/shared/states";
import { Badge } from "@/components/shared/tone";
import { Input } from "@/components/ui/input";
import { useChannels } from "@/hooks/use-data";
import {
  formatCompact,
  formatNumber,
  formatPercent,
  formatRelative,
} from "@/lib/format";
import type { ChannelSummary } from "@/lib/types";

export function ChannelsView({
  scopedGuildId,
}: {
  scopedGuildId: string | null;
}) {
  const [search, setSearch] = useState("");

  const channels = useChannels(search, scopedGuildId ?? undefined);

  const rows = useMemo(() => {
    const data = channels.data?.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter((c) => (c.channel_name ?? "").toLowerCase().includes(q));
  }, [channels.data?.data, search]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          Channels
        </h1>
        <p className="text-xs text-ink-muted">
          Volume, flagged rate, and the analysed culture of each channel
        </p>
      </header>

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Filter channels…"
        aria-label="Filter channels"
        className="w-full sm:w-72"
      />

      {channels.error && !channels.data ? (
        <ErrorState
          error={channels.error}
          onRetry={() => void channels.refetch()}
        />
      ) : rows.length === 0 ? (
        search ? (
          <NoResultsState query={search} />
        ) : (
          <EmptyState title="No channels captured yet" />
        )
      ) : (
        <ul className="space-y-2" aria-busy={channels.isFetching || undefined}>
          {rows.map((channel) => (
            <li key={channel.channel_id}>
              <ChannelRow channel={channel} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelRow({ channel }: { channel: ChannelSummary }) {
  const flaggedRate =
    channel.total_messages > 0
      ? (channel.flagged_count / channel.total_messages) * 100
      : 0;

  return (
    <article className="channel-row hud-card px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="min-w-0 truncate text-sm font-medium text-ink">
          {channel.channel_name || `#${channel.channel_id}`}
        </h2>
        <span className="font-mono text-micro text-ink-faint">
          {channel.channel_id}
        </span>

        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="reactor-count text-ink-muted">
            {formatCompact(channel.total_messages)} msgs
          </span>
          <span className="reactor-count text-ink-muted">
            {formatNumber(channel.flagged_count)} flagged
          </span>
          <Badge tone={flaggedRate > 5 ? "warning" : "neutral"}>
            {formatPercent(flaggedRate, 1)}
          </Badge>
        </div>
      </div>

      {channel.culture_summary ? (
        <details className="group mt-2">
          <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink-soft">
            Channel culture summary
            {channel.last_analyzed_at && (
              <span className="ml-2 font-mono text-ink-faint">
                analysed {formatRelative(channel.last_analyzed_at)}
              </span>
            )}
          </summary>
          <div className="mt-2 border-l-2 border-hairline pl-3">
            <Markdown compact>{channel.culture_summary}</Markdown>
          </div>
        </details>
      ) : (
        <p className="mt-1.5 text-xs text-ink-faint italic">
          No culture summary yet.
        </p>
      )}
    </article>
  );
}
