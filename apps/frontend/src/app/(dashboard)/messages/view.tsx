"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { MessageFeedCard } from "@/components/MessageFeedCard";
import {
  InfiniteScrollSentinel,
  LoadMoreFallback,
  usePagedCount,
  useScrollReset,
} from "@/components/shared/infinite-scroll";
import { ChannelPicker, GuildPicker } from "@/components/shared/pickers";
import {
  EmptyState,
  ErrorState,
  NoResultsState,
} from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  flattenPages,
  useEditFeed,
  useGuilds,
  useMessageFeed,
  useReviewFeed,
  useTextChannels,
} from "@/hooks/use-data";
import {
  filterFromUrl,
  PIPELINE_STATUSES,
  VERDICT_STATUSES,
} from "@/lib/ai-status";
import { formatRelative, humanize } from "@/lib/format";
import type { Message, MessageEdit } from "@/lib/types";
import { useWsEvent } from "@/lib/ws/context";

/**
 * Sentinel for "no filter" in the shadcn Select. A Select cannot hold "" —
 * base-ui reads it as "nothing selected" and shows the placeholder — so the
 * unfiltered state needs an explicit token. It is mapped back to undefined
 * before it reaches the backend and is never shown to the user, because each
 * Select below passes an `items` label map so the trigger renders text.
 */
const ANY = "__any__";
const FEED_LIMIT = 50;
const REVIEW_LIMIT = 20;
// The edit log is the densest of the three (one row per edit, often several per
// message in a cleanup spree), so a smaller page keeps the first paint fast
// while the sentinel keeps making more reachable.
const EDIT_LIMIT = 25;

/**
 * Label maps for the two filter Selects.
 *
 * Without `items`, `<Select.Value>` falls back to printing the raw item value,
 * so the trigger showed the literal "__any__". Passing the map on the Root
 * lets base-ui resolve the label on the server too, where the item portal is
 * not mounted.
 */
const PIPELINE_ITEMS: Record<string, string> = {
  [ANY]: "Any queue state",
  ...Object.fromEntries(
    PIPELINE_STATUSES.map((status) => [status, humanize(status)]),
  ),
};

const VERDICT_ITEMS: Record<string, string> = {
  [ANY]: "Any verdict",
  ...Object.fromEntries(
    VERDICT_STATUSES.map((verdict) => [verdict, humanize(verdict)]),
  ),
};

export function MessagesView({
  defaultGuildId,
}: {
  defaultGuildId: string | null;
}) {
  // Drill-down filters arrive in the URL (W2). Every stat tile on the
  // dashboard links here with `?status=` or `?verdict=`, so the view has to
  // seed its filter state from the query string -- otherwise the link lands on
  // an unfiltered list, which is what made the app's one pre-existing
  // drill-down (`/messages?status=dead`) a dead link.
  const [params, setParams] = useSearchParams();
  const urlStatus = filterFromUrl(params.get("status"), PIPELINE_STATUSES, ANY);
  const urlVerdict = filterFromUrl(
    params.get("verdict"),
    VERDICT_STATUSES,
    ANY,
  );

  const [guildId, setGuildId] = useState<string | null>(defaultGuildId);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState<string>(urlStatus);
  const [verdictFilter, setVerdictFilter] = useState<string>(urlVerdict);

  // Keep the address bar in step with the filters so a reload -- or a shared
  // link -- reproduces the same list. Written back only when something
  // actually changed, otherwise every filter change would push a history entry.
  useEffect(() => {
    if (pipelineFilter === urlStatus && verdictFilter === urlVerdict) return;
    const next = new URLSearchParams();
    if (pipelineFilter !== ANY) next.set("status", pipelineFilter);
    if (verdictFilter !== ANY) next.set("verdict", verdictFilter);
    setParams(next, { replace: true });
  }, [pipelineFilter, verdictFilter, urlStatus, urlVerdict, setParams]);

  const guilds = useGuilds();
  const channels = useTextChannels(guildId);

  const messageQuery = useMemo(
    () => ({
      // The backend rejects a list with neither guild nor channel, so only ask
      // once a guild is actually selected.
      channelId: channelId ?? undefined,
      guildId: channelId ? undefined : (guildId ?? undefined),
      limit: FEED_LIMIT,
      status: pipelineFilter === ANY ? undefined : (pipelineFilter as never),
      verdict: verdictFilter === ANY ? undefined : (verdictFilter as never),
    }),
    [channelId, guildId, pipelineFilter, verdictFilter],
  );

  // `initial*` seeds come from the route, which blocked its own render on them.
  // They are handed to Query as the first page's data rather than as SWR
  // `fallbackData`, so the cache and the rendered list cannot disagree about
  // whether page one exists.
  const messages = useMessageFeed(messageQuery, Boolean(guildId));
  const review = useReviewFeed(channelId ?? undefined, REVIEW_LIMIT);
  const edits = useEditFeed(channelId ?? undefined, EDIT_LIMIT);

  // Switching scope changes what every tab is showing, and paging appends to the
  // bottom — without this the viewport stays parked at the end of the previous,
  // much longer list, which reads as "the new filter loaded nothing".
  useScrollReset(`${guildId ?? ""}:${channelId ?? ""}`);

  // A new message arrives: revalidate the feed. A verdict arriving changes a
  // row in place, so refresh that too rather than showing a stale "unjudged".
  //
  // `refetch` and not a cache write: the WS payload is a notification, not the
  // row. Trusting it as data would mean reimplementing the mapping the backend
  // already does, and any drift would show as a permanently wrong row instead
  // of a momentarily stale one.
  useWsEvent("message_created", () => {
    void messages.refetch();
  });
  useWsEvent("message_analyzed", () => {
    void messages.refetch();
    void review.refetch();
  });
  useWsEvent("message_deleted", () => {
    void messages.refetch();
  });
  useWsEvent("message_updated", () => {
    void edits.refetch();
  });

  const onGuildChange = useCallback((next: string) => {
    setGuildId(next);
    setChannelId(null);
  }, []);

  // A page reports "there is more" by handing back a cursor; a null cursor on
  // the LAST page is the only end-of-list signal, so `hasNextPage` is derived
  // rather than counted.
  const feedRows = useMemo(
    () => flattenPages<Message>(messages.data?.pages, "data"),
    [messages.data?.pages],
  );
  const reviewRows = useMemo(
    () => flattenPages<Message>(review.data?.pages, "results"),
    [review.data?.pages],
  );
  const editRows = useMemo(
    () => flattenPages<MessageEdit>(edits.data?.pages, "results"),
    [edits.data?.pages],
  );

  // The tab badges count what is LOADED, not what the backend holds — a badge
  // reading 400 on a 12-row list was the tell that this data used to be
  // unpaginated. Labelled with the count so it is honest about that.
  const reviewCount = reviewRows.length;
  const editCount = editRows.length;

  const feed = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return feedRows;
    // Client-side over LOADED rows only. The backend has no text search on this
    // endpoint, so filtering everything here would silently lie about the total;
    // filtering the loaded window keeps the visible list honest and the
    // placeholder says "loaded messages".
    return feedRows.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q),
    );
  }, [feedRows, search]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            Messages
          </h1>
          <p className="text-xs text-ink-muted">
            Live feed, enforcement log, and edit history
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <GuildPicker
            guilds={guilds.data ?? []}
            value={guildId}
            onChange={onGuildChange}
          />
          <ChannelPicker
            channels={channels.data ?? []}
            value={channelId}
            onChange={setChannelId}
            disabled={!guildId}
          />
        </div>
      </header>

      <Tabs defaultValue="feed">
        <TabsList className="tabs-touch">
          <TabsTrigger value="feed">Feed</TabsTrigger>
          <TabsTrigger value="enforced">
            Enforced
            {reviewCount > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {reviewCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="edits">
            Edits
            {editCount > 0 && (
              <Badge variant="outline" className="ml-1.5">
                {editCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="feed" className="mt-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter loaded messages…"
                aria-label="Filter messages"
                className="w-full sm:w-64"
              />

              <Select
                items={PIPELINE_ITEMS}
                value={pipelineFilter}
                onValueChange={(v) => setPipelineFilter(v ?? ANY)}
              >
                <SelectTrigger
                  size="sm"
                  className="min-h-11 sm:min-h-8 w-44"
                  aria-label="Queue state"
                >
                  <SelectValue placeholder="Queue state" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any queue state</SelectItem>
                  {PIPELINE_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {humanize(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                items={VERDICT_ITEMS}
                value={verdictFilter}
                onValueChange={(v) => setVerdictFilter(v ?? ANY)}
              >
                <SelectTrigger
                  size="sm"
                  className="min-h-11 sm:min-h-8 w-44"
                  aria-label="Verdict"
                >
                  <SelectValue placeholder="Verdict" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any verdict</SelectItem>
                  {VERDICT_STATUSES.map((verdict) => (
                    <SelectItem key={verdict} value={verdict}>
                      {humanize(verdict)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {messages.error && !messages.data ? (
              <ErrorState
                error={messages.error}
                onRetry={() => void messages.refetch()}
              />
            ) : !guildId ? (
              <EmptyState
                title="Select a guild"
                description="The message archive is empty until the gateway captures its first message."
              />
            ) : feed.length === 0 ? (
              search ? (
                <NoResultsState query={search} />
              ) : (
                <EmptyState title="No messages match these filters" />
              )
            ) : (
              <>
                <ul
                  className="space-y-2"
                  aria-busy={messages.isFetching || undefined}
                >
                  {feed.map((message) => (
                    <li key={message.id}>
                      <MessageFeedCard message={message} />
                    </li>
                  ))}
                </ul>
                {/* The sentinel only renders while another page exists, so
                    there is nothing to scroll past the last page. */}
                <InfiniteScrollSentinel
                  onLoadMore={() => void messages.fetchNextPage()}
                  hasMore={messages.hasNextPage}
                  isFetching={messages.isFetchingNextPage}
                  label="feed"
                />
                <LoadMoreFallback
                  onLoadMore={() => void messages.fetchNextPage()}
                  hasMore={messages.hasNextPage}
                  isFetching={messages.isFetchingNextPage}
                  label="messages"
                />
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="enforced" className="mt-4">
          <EnforcementLog
            messages={reviewRows}
            loading={review.isFetching}
            error={review.error}
            onRetry={() => void review.refetch()}
            hasMore={review.hasNextPage}
            onLoadMore={() => void review.fetchNextPage()}
            isLoadingMore={review.isFetchingNextPage}
          />
        </TabsContent>

        <TabsContent value="edits" className="mt-4">
          <EditHistory
            edits={editRows}
            loading={edits.isFetching}
            error={edits.error}
            onRetry={() => void edits.refetch()}
            hasMore={edits.hasNextPage}
            onLoadMore={() => void edits.fetchNextPage()}
            isLoadingMore={edits.isFetchingNextPage}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The enforcement log: what the pipeline already acted on.
 *
 * THIS IS NOT A HUMAN REVIEW QUEUE. Nothing here is waiting for a person to
 * approve it — the gateway's auto-delete enforcer (`autoDeleteEligibility.ts`)
 * decides and deletes on its own, and `verdicts.status` is `clean | deleted |
 * error` with no review tier between them. The endpoint kept its historical
 * name (`messages.review`) on the backend, which is where the old wording
 * leaked in from.
 *
 * What it actually lists, from `messages.review`'s filter: verdicts that called
 * for the message to go (`verdict = deleted`), PLUS messages stuck in `dead`,
 * where the worker exhausted its retries and so will never be judged at all.
 * Those two are shown together because they are the two ways a message ends up
 * removed or unhandled — the "what did the bot do, and what did it fail to do"
 * view.
 *
 * An earlier version filtered `ai_status IN ('warn','flagged')` — values the
 * database CHECK constraint forbids, so the query matched nothing and this
 * panel was permanently empty while moderation was working fine.
 *
 * Paged because the log is unbounded in principle: every removed message
 * accumulates, and a busy week holds more than any fixed page can.
 */
function EnforcementLog({
  messages,
  loading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  isLoadingMore,
}: {
  messages: Message[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}) {
  const progress = usePagedCount(messages, hasMore);

  if (error && messages.length === 0) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  if (messages.length === 0) {
    return (
      <EmptyState
        title="Nothing removed yet"
        description="Messages the pipeline deleted, plus any it failed to judge, appear here."
      />
    );
  }

  return (
    <>
      <ul className="space-y-2" aria-busy={loading || undefined}>
        {messages.map((message) => (
          <li key={message.id}>
            <MessageFeedCard message={message} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-center text-xs text-ink-muted">
        {progress.label}
      </p>
      <InfiniteScrollSentinel
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetching={isLoadingMore}
        label="enforced messages"
      />
      <LoadMoreFallback
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetching={isLoadingMore}
        label="enforcement log entries"
      />
    </>
  );
}

/**
 * Recent edits, newest first.
 *
 * Worth its own tab because an edit that changes a message AFTER it was
 * judged is the signature of someone cleaning up before a moderator looks.
 */
function EditHistory({
  edits,
  loading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  isLoadingMore,
}: {
  edits: MessageEdit[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  isLoadingMore: boolean;
}) {
  const progress = usePagedCount(edits, hasMore);

  if (error && edits.length === 0) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  if (edits.length === 0) {
    return <EmptyState title="No recent edits" />;
  }

  return (
    <>
      <ul className="space-y-2" aria-busy={loading || undefined}>
        {edits.map((edit) => (
          <li key={edit.id} className="hud-card px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="text-ink-soft">
                {edit.username ?? "unknown"}
              </span>
              <span>in {edit.channel_name ?? `#${edit.channel_id}`}</span>
              <span className="ml-auto font-mono">
                {formatRelative(edit.edited_at)}
              </span>
            </div>
            <div className="mt-1.5 space-y-1">
              <p className="text-xs text-vermilion break-words line-through">
                {edit.old_content}
              </p>
              <p className="text-xs text-ink-soft break-words">
                {edit.new_content}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-center text-xs text-ink-muted">
        {progress.label}
      </p>
      <InfiniteScrollSentinel
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetching={isLoadingMore}
        label="edits"
      />
      <LoadMoreFallback
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isFetching={isLoadingMore}
        label="edit history entries"
      />
    </>
  );
}
