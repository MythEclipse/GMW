"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type {
  Guild,
  Message,
  MessageEdit,
  MessagePage,
  TextChannel,
} from "@/lib/types";
import { MessagesView } from "./view";

/**
 * Client route for /messages — was a server component.
 *
 * Two things the server did that no SWR hook can reproduce, both reproduced
 * here in the same order:
 *
 *  1. `guildId` is derived as `guilds[0]?.id ?? defaultGuildId` and seeded into
 *     the view's `useState`. It is the root of the guild → channels → messages
 *     chain, and `useTextChannels` keys on `guildId ? … : null`, so a null
 *     guildId means the channel picker never fetches at all.
 *
 *  2. `getMessages` REQUIRES a guild or channel id. When the archive is empty
 *     (no `messages.guilds` row yet) the server skipped the call entirely
 *     rather than issuing a request the backend rejects with a
 *     ValidationError. That guard is preserved — see `EMPTY_PAGE`.
 */
const REVIEW_LIMIT = 20;
const FEED_LIMIT = 50;

export function MessagesPage() {
  const fetcher = useCallback(async () => {
    const guilds = (await browserApi.messages.guilds()) as unknown as Guild[];
    const defaultGuildId = await browserApi.config.defaultGuildId();
    const guildId = guilds?.[0]?.id ?? defaultGuildId;

    const [channels, review, edits] = await Promise.all([
      guildId
        ? (browserApi.messages.textChannels(guildId) as unknown as Promise<
            TextChannel[]
          >)
        : Promise.resolve([] as TextChannel[]),
      browserApi.messages.review({
        limit: REVIEW_LIMIT,
      }) as unknown as Promise<{ results: Message[] }>,
      browserApi.messages.editHistory({
        limit: 25,
      }) as unknown as Promise<MessageEdit[]>,
    ]);

    // Same guard as the server version: never call messages.list without a
    // scope, or the backend throws ValidationError.
    const EMPTY_PAGE: MessagePage = { data: [], nextCursor: null };
    const messages = guildId
      ? ((await browserApi.messages.list({
          guildId,
          limit: FEED_LIMIT,
        })) as unknown as MessagePage)
      : EMPTY_PAGE;

    return {
      guilds: guilds ?? [],
      channels: channels ?? [],
      messages: messages?.data ?? [],
      review: review?.results ?? [],
      edits: edits ?? [],
      defaultGuildId: guildId ?? null,
    };
  }, []);

  const seed = useRouteSeed(fetcher);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading messages" />;
  }

  return (
    <MessagesView
      initialGuilds={seed.data.guilds}
      initialChannels={seed.data.channels}
      initialMessages={seed.data.messages}
      initialReview={seed.data.review}
      initialEdits={seed.data.edits}
      defaultGuildId={seed.data.defaultGuildId}
    />
  );
}
