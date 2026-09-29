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
 * Sentinel for "no filter" in the shadcn Select.
 *
 * A Select cannot hold an empty-string value — base-ui treats "" as "nothing
 * selected" and renders the placeholder — so an explicit token is needed. It is
 * mapped back to null in the change handler and is NEVER shown to the user,
 * because every Select here passes an `items` map (see below) so the trigger
 * renders the human label.
 */
export const ALL_CHANNELS = "__all__";

/**
 * Guild + channel pickers, built on the shadcn `Select` primitive.
 *
 * `items` is the important part. Without it, `<Select.Value>` falls back to
 * rendering the raw item VALUE, so the trigger displayed the literal strings
 * "__all__" / "__any__" / the bare guild snowflake. That is not cosmetic: the
 * portal that holds the items is not mounted during the server render, so
 * base-ui has nothing to resolve a label from. Passing `items` on the Root
 * gives it the label map up front, which fixes both SSR and the post-hydration
 * render.
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
      <SelectTrigger
        size="sm"
        disabled
        className="min-h-11 sm:min-h-8 w-full sm:w-52"
        aria-label="Guild"
      >
        No guilds yet
      </SelectTrigger>
    );
  }

  // The backend only stores a guild NAME for some guilds; the rest fall back to
  // the id. Showing a bare snowflake is honest but unreadable, so the id is
  // kept as a secondary line.
  const items = Object.fromEntries(
    guilds.map((guild) => [
      guild.id,
      guild.name && guild.name !== `Guild ${guild.id}`
        ? guild.name
        : `Guild ${guild.id.slice(-6)}`,
    ]),
  );

  return (
    <Select
      items={items}
      value={value ?? undefined}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className="min-h-11 sm:min-h-8 w-full sm:w-52"
        aria-label="Guild"
      >
        <SelectValue placeholder="Select a guild" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Guilds</SelectLabel>
          {guilds.map((guild) => (
            <SelectItem key={guild.id} value={guild.id}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  {guild.name && guild.name !== `Guild ${guild.id}`
                    ? guild.name
                    : `Guild ${guild.id.slice(-6)}`}
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {guild.id}
                </span>
              </span>
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
  const items: Record<string, React.ReactNode> = {};
  if (allowAll) items[ALL_CHANNELS] = allLabel;
  for (const channel of channels) {
    items[channel.id] = channelLabel(channel.name, channel.id);
  }

  return (
    <Select
      items={items}
      value={value ?? (allowAll ? ALL_CHANNELS : undefined)}
      onValueChange={(next) => {
        if (!next) return;
        onChange(next === ALL_CHANNELS ? null : next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className="min-h-11 sm:min-h-8 w-full sm:w-56"
        aria-label="Channel"
      >
        <SelectValue placeholder="Select a channel" />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectGroup>
          {allowAll && (
            <SelectItem value={ALL_CHANNELS}>
              <span className="flex items-center gap-1.5">
                <Hash className="size-3 text-muted-foreground" aria-hidden />
                {allLabel}
              </span>
            </SelectItem>
          )}
          {channels.map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              <span className="flex items-center gap-1.5">
                <Hash className="size-3 text-muted-foreground" aria-hidden />
                {channelLabel(channel.name, channel.id)}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
