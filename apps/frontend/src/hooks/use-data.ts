"use client";

import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { browserApi } from "@/lib/api/browser";
import type {
  ActivityCell,
  ChannelCulture,
  ChannelPage,
  DashboardActivity,
  DashboardStats,
  FlaggedChannel,
  FlaggedDomain,
  GlossaryTerm,
  Guild,
  MessageEdit,
  MessagePage,
  MessageQuery,
  ModerationActionPage,
  ModerationStats,
  ModerationTrends,
  ReviewResult,
  TextChannel,
  TopReaction,
  TopReactor,
  UserPage,
} from "@/lib/types";

/**
 * TanStack Query data layer — replaces the SWR hooks this file used to hold.
 *
 * WHY THIS IS A REWRITE AND NOT A SWAP
 *
 * SWR and TanStack Query disagree on the three things this app leans on most:
 * cache identity, refetch policy, and pagination. None of them is a
 * rename-and-import:
 *
 *  - **Identity.** SWR keys were hand-built template strings (`K.messagePage`
 *    interpolated the query object). Query keys here are structured arrays, so
 *    `["messages","list",{...}]` hashes the same way for equal objects and
 *    different for different ones — which is what makes a prefix invalidate a
 *    whole family.
 *  - **Refetch.** SWR's `fallbackData` was threaded through every call site as
 *    an `initialData` prop from the route seed. Query reads that from the cache
 *    instead, seeded once per route.
 *  - **Pagination.** SWR Infinite's `getKey(i, prev)` is a positional page
 *    index; this backend pages by an opaque cursor, so page 3 is not "offset
 *    150" — it is "whatever page 2's nextCursor said". The key function
 *    therefore has to read the previous page's token, and returning `null`
 *    from it is what terminates paging.
 *
 * NO POLLING, DELIBERATELY
 *
 * `refetchInterval` appears only where it did before (the live headline
 * counters). Everything else revalidates from the `/ws` socket via
 * `useInvalidate`, because a timer re-fetching the same data the socket already
 * pushes races it — which is how the review queue used to show stale verdicts.
 */
const LIVE = 30_000;

const shared = {
  // Re-focusing the tab re-fetching every panel is noise on an ops dashboard
  // that is already live; matches the old `revalidateOnFocus: false`.
  refetchOnWindowFocus: false,
  retry: 3,
  retryDelay: 4_000,
} as const;

/** Query-key factory. One place, so invalidation prefixes stay in sync. */
export const qk = {
  stats: ["dashboard", "stats"] as const,
  activity: (days: number) => ["dashboard", "activity", days] as const,
  users: (search: string) => ["dashboard", "users", search || "*"] as const,
  userDetail: (id: string) => ["dashboard", "userDetail", id] as const,
  channels: (search: string) =>
    ["dashboard", "channels", search || "*"] as const,
  channelDetail: (id: string) => ["dashboard", "channelDetail", id] as const,
  reactions: (limit: number) => ["dashboard", "reactions", limit] as const,
  reactors: (limit: number) => ["dashboard", "reactors", limit] as const,
  guilds: ["messages", "guilds"] as const,
  textChannels: (guildId: string) =>
    ["messages", "textChannels", guildId] as const,
  messagePage: (query: MessageQuery) => ["messages", "list", query] as const,
  review: (channelId: string | undefined) =>
    ["messages", "review", channelId ?? "all"] as const,
  messageActivity: (days: number) => ["messages", "activity", days] as const,
  edits: (channelId: string | undefined) =>
    ["messages", "edits", channelId ?? "all"] as const,
  modStats: ["moderation", "stats"] as const,
  modActions: (status: string, actionType: string) =>
    ["moderation", "actions", status, actionType] as const,
  modTrends: (days: number) => ["moderation", "trends", days] as const,
  domains: (days: number) => ["moderation", "domains", days] as const,
  flaggedChannels: (days: number) => ["moderation", "channels", days] as const,
  hourly: (days: number) => ["moderation", "hourly", days] as const,
  coverage: (days: number) => ["moderation", "coverage", days] as const,
  search: (q: string, channelId: string | undefined) =>
    ["analysis", "search", q, channelId ?? "all"] as const,
  cultures: (search: string) =>
    ["knowledge", "cultures", search || "*"] as const,
  glossary: (search: string) =>
    ["knowledge", "glossary", search || "*"] as const,
} as const;

/** A paged list whose backend hands back an opaque resume token. */
export interface CursorPage<T> {
  results: T[];
  nextCursor: string | null;
}

// ── Dashboard ───────────────────────────────────────────────────────────────

export function useStats() {
  return useQuery({
    queryKey: qk.stats,
    queryFn: () => browserApi.dashboard.stats() as Promise<DashboardStats>,
    ...shared,
  });
}

export function useActivity(days: number) {
  return useQuery({
    queryKey: qk.activity(days),
    queryFn: () =>
      browserApi.dashboard.activity(days) as Promise<DashboardActivity>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useUsers(search: string) {
  return useQuery({
    queryKey: qk.users(search),
    queryFn: () =>
      browserApi.dashboard.users({
        limit: 20,
        search: search || undefined,
      }) as Promise<UserPage>,
    ...shared,
    placeholderData: (prev) => prev,
  });
}

export function useUserDetail(userId: string) {
  return useQuery({
    queryKey: qk.userDetail(userId),
    queryFn: () => browserApi.dashboard.userDetail(userId),
    ...shared,
  });
}

export function useChannels(search: string, guildId?: string) {
  return useQuery({
    queryKey: [...qk.channels(search), guildId ?? "*"],
    queryFn: () =>
      browserApi.dashboard.channels({
        limit: 50,
        search: search || undefined,
        guildId,
      }) as Promise<ChannelPage>,
    ...shared,
    placeholderData: (prev) => prev,
  });
}

export function useChannelDetail(channelId: string) {
  return useQuery({
    queryKey: qk.channelDetail(channelId),
    queryFn: () => browserApi.dashboard.channelDetail(channelId),
    ...shared,
  });
}

export function useTopReactions(limit: number) {
  return useQuery({
    queryKey: qk.reactions(limit),
    queryFn: () =>
      browserApi.dashboard.reactions(limit) as Promise<TopReaction[]>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useTopReactors(limit: number) {
  return useQuery({
    queryKey: qk.reactors(limit),
    queryFn: () =>
      browserApi.dashboard.reactors(limit) as Promise<TopReactor[]>,
    ...shared,
    refetchInterval: LIVE,
  });
}

// ── Messages ────────────────────────────────────────────────────────────────

export function useGuilds() {
  return useQuery({
    queryKey: qk.guilds,
    queryFn: () => browserApi.messages.guilds() as Promise<Guild[]>,
    ...shared,
  });
}

export function useTextChannels(guildId: string | null) {
  return useQuery({
    // `enabled` is the equivalent of the old `null` SWR key: without a guild
    // the picker shows nothing instead of firing a request the backend
    // rejects. The key still has to be STABLE and distinct, hence the literal.
    queryKey: guildId
      ? qk.textChannels(guildId)
      : (["messages", "textChannels", null] as const),
    queryFn: () =>
      browserApi.messages.textChannels(guildId as string) as Promise<
        TextChannel[]
      >,
    enabled: Boolean(guildId),
    ...shared,
    placeholderData: (prev) => prev,
  });
}

/**
 * The live feed, paged by cursor and growing as the user scrolls.
 *
 * `getNextPageParam` extracts the backend's resume token; a page whose
 * `nextCursor` is null yields `undefined`, which is how Query learns there is no
 * page `n+1`. The two must agree with the key function or the list either
 * stalls early or fetches the same page forever.
 */
export function useMessageFeed(
  query: MessageQuery,
  enabled: boolean,
): UseInfiniteQueryResult<
  InfiniteData<MessagePage, string | undefined>,
  Error
> {
  return useInfiniteQuery({
    queryKey: qk.messagePage(query),
    queryFn: ({ pageParam }) =>
      browserApi.messages.list({
        ...query,
        cursor: pageParam ?? undefined,
      }) as Promise<MessagePage>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // The backend rejects a list with neither guild nor channel, so the feed
    // stays disabled until the view has picked a scope — the same guard the
    // route seed used to apply by not issuing the call at all.
    enabled: enabled && Boolean(query.guildId || query.channelId),
    ...shared,
  }) as UseInfiniteQueryResult<
    InfiniteData<MessagePage, string | undefined>,
    Error
  >;
}

/**
 * The review queue, paged. Same cursor mechanism as the feed; the backend sorts
 * it actionable-first, so paging walks down a priority ranking rather than
 * backwards through time.
 *
 * `review` answers `{ results, limit, cursor }` — the resume token is `cursor`,
 * not `nextCursor`, because that field predates this pagination.
 */
export function useReviewFeed(
  channelId: string | undefined,
  limit: number,
): UseInfiniteQueryResult<
  InfiniteData<ReviewResult, string | undefined>,
  Error
> {
  return useInfiniteQuery({
    queryKey: [...qk.review(channelId), limit],
    queryFn: ({ pageParam }) =>
      browserApi.messages.review({
        limit,
        channelId,
        cursor: pageParam ?? undefined,
      }) as Promise<ReviewResult>,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...shared,
  }) as UseInfiniteQueryResult<
    InfiniteData<ReviewResult, string | undefined>,
    Error
  >;
}

/**
 * Recent edits, paged. The backend changed this endpoint from a bare array to
 * `{ results, nextCursor }` so all three tabs scroll the same way.
 */
export function useEditFeed(
  channelId: string | undefined,
  limit: number,
): UseInfiniteQueryResult<
  InfiniteData<CursorPage<MessageEdit> | MessageEdit[], string | undefined>,
  Error
> {
  return useInfiniteQuery({
    queryKey: [...qk.edits(channelId), limit],
    queryFn: ({ pageParam }) =>
      browserApi.messages.editHistory({
        limit,
        channelId,
        cursor: pageParam ?? undefined,
      }) as unknown as Promise<CursorPage<MessageEdit> | MessageEdit[]>,
    initialPageParam: undefined as string | undefined,
    // `undefined` for either shape. A bare array carries no cursor, so an older
    // backend simply yields a single page and the tab degrades to "no further
    // pages" rather than paging forever against an endpoint that ignores it.
    getNextPageParam: (last) =>
      Array.isArray(last) ? undefined : (last.nextCursor ?? undefined),
    ...shared,
  }) as UseInfiniteQueryResult<
    InfiniteData<CursorPage<MessageEdit> | MessageEdit[], string | undefined>,
    Error
  >;
}

export function useMessageActivity(days: number) {
  return useQuery({
    queryKey: qk.messageActivity(days),
    queryFn: () =>
      browserApi.messages.activity(days) as Promise<ActivityCell[]>,
    ...shared,
  });
}

// ── Moderation ──────────────────────────────────────────────────────────────

export function useModerationStats() {
  return useQuery({
    queryKey: qk.modStats,
    queryFn: () => browserApi.moderation.stats() as Promise<ModerationStats>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useModerationActions(status: string, actionType: string) {
  return useQuery({
    queryKey: qk.modActions(status, actionType),
    queryFn: () =>
      browserApi.moderation.actions({
        limit: 50,
        status: status || undefined,
        actionType: actionType || undefined,
      }) as Promise<ModerationActionPage>,
    ...shared,
    placeholderData: (prev) => prev,
  });
}

export function useModerationTrends(days: number) {
  return useQuery({
    queryKey: qk.modTrends(days),
    queryFn: () =>
      browserApi.moderation.trends(days) as Promise<ModerationTrends>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useFlaggedDomains(days: number) {
  return useQuery({
    queryKey: qk.domains(days),
    queryFn: () =>
      browserApi.moderation.topDomains(days) as Promise<FlaggedDomain[]>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useFlaggedChannels(days: number) {
  return useQuery({
    queryKey: qk.flaggedChannels(days),
    queryFn: () =>
      browserApi.moderation.topChannels(days) as Promise<FlaggedChannel[]>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useHourlyModeration<T>(days: number) {
  return useQuery({
    queryKey: qk.hourly(days),
    queryFn: () => browserApi.moderation.byHour(days) as Promise<T>,
    ...shared,
    refetchInterval: LIVE,
  });
}

export function useCoverage<T>(days: number) {
  return useQuery({
    queryKey: qk.coverage(days),
    queryFn: () => browserApi.moderation.coverage(days) as Promise<T>,
    ...shared,
    refetchInterval: LIVE,
  });
}

// ── Analysis / knowledge ────────────────────────────────────────────────────

export function useAnalysisSearch<T>(q: string, channelId: string | undefined) {
  return useQuery({
    // An empty query issues NO request — the old `null` SWR key. The route
    // seed is what fills the initial view; typing is what starts querying.
    queryKey: q
      ? qk.search(q, channelId)
      : (["analysis", "search", "", "*"] as const),
    queryFn: () =>
      browserApi.analysis.search({ q, channelId, limit: 20 }) as Promise<T>,
    enabled: Boolean(q),
    ...shared,
    placeholderData: (prev) => prev,
  });
}

export function useChannelCultures(search: string) {
  return useQuery({
    queryKey: qk.cultures(search),
    queryFn: () =>
      browserApi.knowledge.channelCultures({
        limit: 50,
        search: search || undefined,
      }) as Promise<ChannelCulture[]>,
    ...shared,
    placeholderData: (prev) => prev,
  });
}

export function useGlossary(search: string) {
  return useQuery({
    queryKey: qk.glossary(search),
    queryFn: () =>
      browserApi.knowledge.glossary({
        limit: 50,
        search: search || undefined,
      }) as Promise<GlossaryTerm[]>,
    ...shared,
    placeholderData: (prev) => prev,
  });
}

// ── WS-driven revalidation ──────────────────────────────────────────────────

/**
 * Invalidate a whole query family from a `/ws` event handler.
 *
 * PREFIX matching is the payoff of structured keys: invalidating `["messages"]`
 * re-fetches the feed, the review queue and the edit log at once, with no
 * enumeration of every key that embeds a channel id. The SWR code had to call
 * `.mutate()` on each hook separately, so a forgotten subscriber was easy — and
 * a forgotten subscriber is a permanently stale panel, not a crash.
 */
export function useInvalidate() {
  const client = useQueryClient();
  return (prefix: readonly unknown[]) =>
    client.invalidateQueries({ queryKey: prefix });
}

/**
 * Flatten infinite pages into one list, preserving page order.
 *
 * Takes `field` rather than assuming a page is an array, because the three
 * paged endpoints disagree: `list` answers `{ data, nextCursor }`, `review`
 * answers `{ results, limit, cursor }`, and `editHistory` answers
 * `{ results, nextCursor }`. The generic is on the ELEMENT type, not the page,
 * so callers get `Message[]` / `MessageEdit[]` back rather than `unknown[]`.
 *
 * WHY A BARE PAGE IS ALSO ACCEPTED
 *
 * A page that is itself an array is treated as a single page of `field`-less
 * elements. That is not a shape any current endpoint returns — it exists
 * because the dashboard is served by whatever backend build is running, and an
 * older build answers `editHistory` with a bare array instead of
 * `{ results, nextCursor }`. Without this, a rolling deploy whose frontend is
 * newer than its backend renders "No recent edits" — a confident, plausible,
 * completely wrong empty state rather than an error. Flattening both shapes
 * makes the tab keep working across the deploy window instead of lying.
 */
export function flattenPages<T, P = unknown>(
  pages: ReadonlyArray<P> | undefined,
  field: "results" | "data",
): T[] {
  if (!pages) return [];
  return pages.flatMap((page) => {
    if (Array.isArray(page)) return page as T[];
    return (
      ((page as Record<string, unknown> | undefined)?.[field] as
        | T[]
        | undefined) ?? []
    );
  });
}

export type { UseInfiniteQueryResult, UseQueryResult };
