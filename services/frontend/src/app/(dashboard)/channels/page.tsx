import type { Metadata } from "next";
import { getChannels, getDefaultGuildId, getGuilds } from "@/lib/api/server";
import { ChannelsView } from "./view";

export const metadata: Metadata = { title: "Channels" };

export default async function ChannelsPage() {
  const [guilds, defaultGuildId] = await Promise.all([
    getGuilds(),
    getDefaultGuildId(),
  ]);

  // Scoping to the monitored guild keeps the list to channels this
  // deployment actually watches, instead of every guild in the archive.
  const scoped = defaultGuildId
    ? { guildId: defaultGuildId }
    : guilds[0]?.id
      ? { guildId: guilds[0].id }
      : {};

  const channels = await getChannels({ limit: 50, ...scoped });

  return (
    <ChannelsView
      initialChannels={channels.data}
      scopedGuildId={scoped.guildId ?? null}
    />
  );
}
