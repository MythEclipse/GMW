"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { type CursorPage, qk } from "@/hooks/use-data";
import { type SeedEntry, useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type {
  Guild,
  MessageEdit,
  MessagePage,
  ReviewResult,
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
// Must match `EDIT_LIMIT` in `./view`, or the seed would fetch a different page
// size than the hook's infinite query asks for and the first render would show
// a list the very next fetch immediately replaces.
const EDIT_LIMIT = 25;

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
      }) as unknown as Promise<ReviewResult>,
      browserApi.messages.editHistory({
        limit: EDIT_LIMIT,
      }) as unknown as Promise<CursorPage<MessageEdit> | MessageEdit[]>,
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

    // The PAGES are returned whole, cursor included — not `.data` / `.results`.
    // `prime` below writes each one as page 0 of an infinite query, and a page
    // stripped of its cursor reads as "this is the last page", which would
    // silently disable the very scrolling this route exists for.
    return {
      guilds: guilds ?? [],
      channels: channels ?? [],
      messages,
      review,
      edits,
      defaultGuildId: guildId ?? null,
    };
  }, []);

  // Prime all three paged queries with the seed, so the view's infinite
  // queries mount onto page one instead of re-requesting it.
  //
  // THE KEY SHAPES MATTER AND ARE NOT INTERCHANGEABLE. An infinite query's
  // cache entry is `{ pages: [page0], pageParams: [undefined] }`, not the bare
  // page — seeding `MessagePage` directly would render `data.pages` as
  // `undefined` and crash the list. And the cursor must be carried through, or
  // `getNextPageParam` sees `nextCursor: null`, concludes there is no page 2,
  // and the scroll the user came here for silently does nothing.
  const prime = useCallback(
    (r: {
      guilds: Guild[];
      channels: TextChannel[];
      messages: MessagePage;
      review: ReviewResult;
      edits: CursorPage<MessageEdit> | MessageEdit[];
      defaultGuildId: string | null;
    }) => {
      const scope = r.messages;
      const first: SeedEntry<unknown>[] = [
        {
          key: qk.guilds,
          data: r.guilds,
        },
        {
          key: qk.textChannels(r.defaultGuildId ?? ""),
          data: r.channels,
        },
        {
          key: [
            ...qk.messagePage({
              guildId: r.defaultGuildId ?? undefined,
              limit: FEED_LIMIT,
            }),
          ],
          data: {
            pages: [scope],
            pageParams: [undefined],
          },
        },
        {
          key: [...qk.review(undefined), REVIEW_LIMIT],
          data: { pages: [r.review], pageParams: [undefined] },
        },
        {
          key: [...qk.edits(undefined), EDIT_LIMIT],
          data: { pages: [r.edits], pageParams: [undefined] },
        },
      ];
      return first;
    },
    [],
  );

  const seed = useRouteSeed(fetcher, prime);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading messages" />;
  }

  return <MessagesView defaultGuildId={seed.data.defaultGuildId} />;
}
