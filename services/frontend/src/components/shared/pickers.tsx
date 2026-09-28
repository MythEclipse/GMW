"use client";

import { Hash } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { channelLabel } from "@/lib/format";
import type { Guild, TextChannel } from "@/lib/types";

/**
 * Guild + channel pickers.
 *
 * The guild list is what the backend actually knows: distinct guild ids present
 * in the message archive, with a synthesized name for any guild whose name was
 * never stored. Some ids there are short and non-numeric (test fixtures), so
 * nothing may assume a snowflake.
 */
export function GuildPicker({
  guilds,
  value,
  onChange,
  disabled,
}: {
  guilds: Guild[];
  value: string | null;
  onChange: (guildId: string) => void;
  disabled?: boolean;
}) {
  if (guilds.length === 0) {
    return (
      <div className="flex h-8 items-center rounded-md border border-hairline px-2.5 text-xs text-ink-faint">
        No guilds yet
      </div>
    );
  }

  return (
    <Select
      value={value ?? undefined}
      onValueChange={(next) => next && onChange(next)}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-full sm:w-52" aria-label="Guild">
        <SelectValue placeholder="Select a guild" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Guilds</SelectLabel>
          {guilds.map((guild) => (
            <SelectItem key={guild.id} value={guild.id}>
              {guild.name || `Guild ${guild.id}`}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function ChannelPicker({
  channels,
  value,
  onChange,
  disabled,
  allLabel = "All channels",
  allowAll = true,
}: {
  channels: TextChannel[];
  value: string | null;
  onChange: (channelId: string | null) => void;
  disabled?: boolean;
  allLabel?: string;
  allowAll?: boolean;
}) {
  return (
    <Select
      value={value ?? (allowAll ? "__all__" : undefined)}
      onValueChange={(next) => {
        if (next === "__all__") {
          onChange(null);
          return;
        }
        if (next) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Channel">
        <SelectValue placeholder="Select a channel" />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectGroup>
          {allowAll && <SelectItem value="__all__">{allLabel}</SelectItem>}
          {channels.map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              <span className="flex items-center gap-1.5">
                <Hash className="size-3 text-ink-faint" aria-hidden />
                {channelLabel(channel.name, channel.id)}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
