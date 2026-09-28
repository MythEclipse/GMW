"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGuilds, useTextChannels } from "@/hooks";
import type { Guild } from "@/lib/types";

export function GuildChannelPicker({
  guildsInitial,
  guildId,
  channelId,
  onChange,
}: {
  guildsInitial?: Guild[];
  guildId: string | null;
  channelId: string | null;
  onChange: (guildId: string, channelId: string | null) => void;
}) {
  const { data: guilds } = useGuilds(guildsInitial);
  const textChannels = useTextChannels(guildId ?? "");
  const channels = textChannels.data;

  const [g, setG] = useState(guildId);
  const [c, setC] = useState(channelId);

  useEffect(() => setG(guildId), [guildId]);
  useEffect(() => setC(channelId), [channelId]);

  const guildOpts = (guilds ?? []).map((x) => ({
    value: x.id,
    label: x.name,
  }));
  const channelOpts = (channels ?? []).map((x) => ({
    value: x.id,
    label: x.name,
    hint: x.type,
  }));

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <Select
        value={g}
        onValueChange={(v) => {
          if (v == null) return;
          setG(v);
          setC(null);
          onChange(v, null);
        }}
      >
        <SelectTrigger size="sm" className="w-full sm:w-44">
          <SelectValue placeholder="Guild" />
        </SelectTrigger>
        <SelectContent>
          {guildOpts.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={c}
        onValueChange={(v) => {
          setC(v);
          if (g) onChange(g, v);
        }}
      >
        <SelectTrigger size="sm" className="w-full sm:w-52">
          <SelectValue placeholder="Text channel" />
        </SelectTrigger>
        <SelectContent>
          {channelOpts.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              <span className="flex flex-1 items-baseline justify-between gap-3">
                <span>{o.label}</span>
                {o.hint && (
                  <span className="mono text-micro text-ink-faint">
                    {o.hint}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
