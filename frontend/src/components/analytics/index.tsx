import { useState } from "react";
import type { Channel, Guild } from "../../types/voice";
import { useAnalytics } from "../../hooks/useAnalytics";
import { ControlBar } from "./ControlBar";
import { SummaryCards } from "./SummaryCards";
import { ActivityChart } from "./ActivityChart";
import { TrendChart } from "./TrendChart";
import { Heatmap } from "./Heatmap";
import { TopicList } from "./TopicList";
import { UserTable } from "./UserTable";
import { ViolatorTable } from "./ViolatorTable";

interface AnalyticsPanelProps {
  guilds: Guild[];
  channels: Channel[];
  selectedGuild: string;
  selectedChannel: string;
  onGuildChange: (guildId: string) => void;
  onChannelChange: (channelId: string) => void;
}

export function AnalyticsPanel({
  guilds,
  channels,
  selectedGuild,
  selectedChannel,
  onGuildChange,
  onChannelChange,
}: AnalyticsPanelProps) {
  const [hours, setHours] = useState(24);

  const {
    messages,
    hourly,
    topics,
    topUsers,
    activeUsersCount,
    totalChannels,
    violators,
    trend,
    heatmap,
    isLoading,
    isFetching,
    error,
    refresh,
    refreshViolators,
  } = useAnalytics({ guildId: selectedGuild, channelId: selectedChannel || undefined, hours });

  const loading = isLoading && !isFetching;

  if (error && !messages) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!selectedGuild) {
    return (
      <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
        <p className="text-sm text-muted-foreground">Pilih guild untuk melihat analitik.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Control bar */}
      <ControlBar
        guilds={guilds}
        channels={channels}
        selectedGuild={selectedGuild}
        selectedChannel={selectedChannel}
        hours={hours}
        isFetching={isFetching}
        onGuildChange={onGuildChange}
        onChannelChange={onChannelChange}
        onHoursChange={setHours}
        onRefresh={() => { refresh(); refreshViolators(); }}
      />

      {/* Summary cards */}
      <SummaryCards
        messages={messages}
        activeUsersCount={activeUsersCount}
        totalChannels={totalChannels}
        loading={loading}
      />

      {/* Hourly chart */}
      <div className="grid grid-cols-3 gap-4">
        <ActivityChart hourly={hourly} loading={loading} />
        <div className="col-span-1">
          <TopicList topics={topics} loading={loading} />
        </div>
      </div>

      {/* Trend chart — only show when enough data */}
      {hours >= 48 && (
        <TrendChart trend={trend} loading={loading} />
      )}

      {/* Heatmap + leaderboard */}
      <div className="grid grid-cols-3 gap-4">
        <Heatmap cells={heatmap} loading={loading} />
        <div className="col-span-1">
          <UserTable users={topUsers} loading={loading} />
        </div>
      </div>

      {/* Violators */}
      <ViolatorTable users={violators} loading={loading} />
    </div>
  );
}
