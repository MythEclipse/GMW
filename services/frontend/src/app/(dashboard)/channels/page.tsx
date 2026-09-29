"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type { ChannelPage, Guild } from "@/lib/types";
import { ChannelsView } from "./view";

/**
 * Client route for /channels — was a server component.
 *
 * GUILD SCOPING IS NOT A DISPLAY DETAIL
 *
 * The server version computed `scopedGuildId` as
 * `defaultGuildId ?? guilds[0]?.id ?? null` and passed it to the view, which
 * forwards it to `useChannels`. Scoping to the monitored guild keeps the list
 * to channels this deployment actually watches; without it the page lists every
 * guild in the archive — a silently wrong result, not an error. That
 * computation is reproduced here, including the precedence order.
 *
 * The `limit` of 50 matches the old server call. `useChannels` defaults to 20
 * on its own revalidation, which would shrink the list right after first
 * paint — that mismatch predates this migration and is left alone.
 */
export function ChannelsPage() {
  const fetcher = useCallback(async () => {
    const [guilds, defaultGuildId] = await Promise.all([
      browserApi.messages.guilds() as Promise<Guild[]>,
      browserApi.config.defaultGuildId(),
    ]);

    const scopedGuildId = defaultGuildId ?? guilds?.[0]?.id ?? null;

    const channels = (await browserApi.dashboard.channels({
      limit: 50,
      ...(scopedGuildId ? { guildId: scopedGuildId } : {}),
    })) as unknown as ChannelPage;

    return { channels: channels?.data ?? [], scopedGuildId };
  }, []);

  const seed = useRouteSeed(fetcher);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading channels" />;
  }

  return (
    <ChannelsView
      initialChannels={seed.data.channels}
      scopedGuildId={seed.data.scopedGuildId}
    />
  );
}
