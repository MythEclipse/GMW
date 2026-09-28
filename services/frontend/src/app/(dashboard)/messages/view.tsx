"use client";

import { useCallback, useMemo, useState } from "react";
import { MessageFeedCard } from "@/components/MessageFeedCard";
import { ChannelPicker, GuildPicker } from "@/components/shared/pickers";
import {
  EmptyState,
  ErrorState,
  NoResultsState,
} from "@/components/shared/states";
import { Badge } from "@/components/shared/tone";
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
import { PIPELINE_STATUSES, VERDICT_STATUSES } from "@/lib/ai-status";
import { formatRelative, humanize } from "@/lib/format";
import type { Guild, Message, MessageEdit, TextChannel } from "@/lib/types";
import { useWsEvent } from "@/lib/ws/context";

const ANY = "__any__";
const FEED_LIMIT = 50;
const REVIEW_LIMIT = 20;

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
  const [guildId, setGuildId] = useState<string | null>(defaultGuildId);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState<string>(ANY);
  const [verdictFilter, setVerdictFilter] = useState<string>(ANY);

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
        <TabsList>
          <TabsTrigger value="feed">Feed</TabsTrigger>
          <TabsTrigger value="review">
            Review
            {(review.data?.results.length ?? 0) > 0 && (
              <Badge tone="warning" className="ml-1.5">
                {review.data?.results.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="edits">Edits</TabsTrigger>
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
                value={pipelineFilter}
                onValueChange={(v) => setPipelineFilter(v ?? ANY)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-40"
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
                value={verdictFilter}
                onValueChange={(v) => setVerdictFilter(v ?? ANY)}
              >
                <SelectTrigger size="sm" className="w-40" aria-label="Verdict">
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
