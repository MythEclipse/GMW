"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { MessageFeedCard } from "@/components/MessageFeedCard";
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
  useGuilds,
  useMessages,
  useRecentEdits,
  useReviewMessages,
  useTextChannels,
} from "@/hooks/use-data";
import {
  filterFromUrl,
  PIPELINE_STATUSES,
  VERDICT_STATUSES,
} from "@/lib/ai-status";
import { formatRelative, humanize } from "@/lib/format";
import type { Guild, Message, MessageEdit, TextChannel } from "@/lib/types";
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
  initialGuilds,
  initialChannels,
  initialMessages,
  initialReview,
  initialEdits,
  defaultGuildId,
}: {
  initialGuilds: Guild[];
  initialChannels: TextChannel[];
  initialMessages: Message[];
  initialReview: Message[];
  initialEdits: MessageEdit[];
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

  const guilds = useGuilds(initialGuilds);
  const channels = useTextChannels(guildId, initialChannels);

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

  const messages = useMessages(messageQuery, {
    data: initialMessages,
    nextCursor: null,
  });
  const review = useReviewMessages(channelId ?? undefined, {
    results: initialReview,
    limit: REVIEW_LIMIT,
    cursor: null,
  });
  const edits = useRecentEdits(channelId ?? undefined, initialEdits);

  // A new message arrives: revalidate the feed. A verdict arriving changes a
  // row in place, so refresh that too rather than showing a stale "unjudged".
  useWsEvent("message_created", () => {
    void messages.mutate();
  });
  useWsEvent("message_analyzed", () => {
    void messages.mutate();
    void review.mutate();
  });
  useWsEvent("message_deleted", () => {
    void messages.mutate();
  });
  useWsEvent("message_updated", () => {
    void edits.mutate();
  });

  const onGuildChange = useCallback((next: string) => {
    setGuildId(next);
    setChannelId(null);
  }, []);

  const reviewCount = review.data?.results.length ?? 0;
  const editCount = edits.data?.length ?? 0;

  const feed = useMemo(() => {
    const rows = messages.data?.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q),
    );
  }, [messages.data?.data, search]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            Messages
          </h1>
          <p className="text-xs text-ink-muted">
            Live feed, review queue, and edit history
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
          <TabsTrigger value="review">
            Review
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
                onRetry={() => void messages.mutate()}
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
              <ul
                className="space-y-2"
                aria-busy={messages.isValidating || undefined}
              >
                {feed.map((message) => (
                  <li key={message.id}>
                    <MessageFeedCard message={message} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <ReviewQueue
            messages={review.data?.results ?? []}
            loading={review.isValidating}
            error={review.error}
            onRetry={() => void review.mutate()}
          />
        </TabsContent>

        <TabsContent value="edits" className="mt-4">
          <EditHistory
            edits={edits.data ?? []}
            loading={edits.isValidating}
            error={edits.error}
            onRetry={() => void edits.mutate()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * The review queue: verdicts of `warn` or `flagged`.
 *
 * This is fed by `messages.review`, which filters on the VERDICT column. An
 * earlier version filtered `ai_status IN ('warn','flagged')` — values the
 * database CHECK constraint forbids, so the query matched nothing and this
 * panel was permanently empty while moderation was working fine.
 */
function ReviewQueue({
  messages,
  loading,
  error,
  onRetry,
}: {
  messages: Message[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error && messages.length === 0) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  if (messages.length === 0) {
    return (
      <EmptyState
        title="Nothing needs review"
        description="Messages judged warn or flagged appear here."
      />
    );
  }

  return (
    <ul className="space-y-2" aria-busy={loading || undefined}>
      {messages.map((message) => (
        <li key={message.id}>
          <MessageFeedCard message={message} />
        </li>
      ))}
    </ul>
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
}: {
  edits: MessageEdit[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error && edits.length === 0) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  if (edits.length === 0) {
    return <EmptyState title="No recent edits" />;
  }

  return (
    <ul className="space-y-2" aria-busy={loading || undefined}>
      {edits.map((edit) => (
        <li key={edit.id} className="hud-card px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span className="text-ink-soft">{edit.username ?? "unknown"}</span>
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
  );
}
