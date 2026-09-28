"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { browserApi } from "@/lib/api/browser";
import type {
  ActivityCell,
  ChannelCulture,
  ChannelDetail,
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
 * SWR hooks, one per domain.
 *
 * PATTERN: every hook takes `initialData` (the value its server component
 * already fetched) and returns it as SWR `fallbackData`. The page therefore
 * paints real content on first render with no spinner, and the hook takes over
 * revalidation on the client.
 *
 * `refreshInterval` is deliberately ABSENT. Live state arrives over the `/ws`
 * socket; polling the same data on a timer would double-fetch and race the
 * socket, which is how the old review queue ended up showing stale verdicts.
 */
const LIVE = 30_000;

const shared: SWRConfiguration = {
  revalidateOnFocus: false,
  shouldRetryOnError: true,
  errorRetryCount: 3,
  errorRetryInterval: 4_000,
};

type Fetcher<T> = () => Promise<T>;

/** SWR needs a stable key; a null key disables the request. */
const K = {
  stats: "dashboard:stats",
  activity: (days: number) => `dashboard:activity:${days}`,
  users: (search: string) => `dashboard:users:${search || "*"}`,
  userDetail: (id: string) => `dashboard:userDetail:${id}`,
  channels: (search: string) => `dashboard:channels:${search || "*"}`,
  channelDetail: (id: string) => `dashboard:channelDetail:${id}`,
  reactions: (limit: number) => `dashboard:reactions:${limit}`,
  reactors: (limit: number) => `dashboard:reactors:${limit}`,
  guilds: "messages:guilds",
  textChannels: (guildId: string) => `messages:textChannels:${guildId}`,
  messagePage: (query: MessageQuery) =>
    `messages:list:${JSON.stringify(query)}`,
  review: (channelId: string | undefined) =>
    `messages:review:${channelId ?? "all"}`,
  messageActivity: (days: number) => `messages:activity:${days}`,
  edits: (channelId: string | undefined) =>
    `messages:edits:${channelId ?? "all"}`,
  modStats: "moderation:stats",
  modActions: (status: string, actionType: string) =>
    `moderation:actions:${status}:${actionType}`,
  modTrends: (days: number) => `moderation:trends:${days}`,
  domains: (days: number) => `moderation:domains:${days}`,
  flaggedChannels: (days: number) => `moderation:channels:${days}`,
  hourly: (days: number) => `moderation:hourly:${days}`,
  coverage: (days: number) => `moderation:coverage:${days}`,
  search: (q: string, channelId: string | undefined) =>
    `analysis:search:${q}:${channelId ?? "all"}`,
  cultures: (search: string) => `knowledge:cultures:${search || "*"}`,
  glossary: (search: string) => `knowledge:glossary:${search || "*"}`,
};

// ── Dashboard ───────────────────────────────────────────────────────────────

export function useStats(initialData: DashboardStats) {
  return useSWR<DashboardStats>(
    K.stats,
    () => browserApi.dashboard.stats() as Promise<DashboardStats>,
    {
      ...shared,
      fallbackData: initialData,
      refreshInterval: LIVE,
    },
  );
}

export function useActivity(days: number, initialData: DashboardActivity) {
  return useSWR<DashboardActivity>(
    K.activity(days),
    () => browserApi.dashboard.activity(days) as Promise<DashboardActivity>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useUsers(
  search: string,
  initialData: UserPage,
  cursor?: string,
) {
  return useSWR<UserPage>(
    K.users(search),
    () =>
      browserApi.dashboard.users({
        limit: 20,
        search: search || undefined,
        cursor,
      }) as Promise<UserPage>,
    { ...shared, fallbackData: initialData },
  );
}

export function useUserDetail(userId: string) {
  return useSWR(K.userDetail(userId), () =>
    browserApi.dashboard.userDetail(userId),
  );
}

export function useChannels(
  search: string,
  initialData: ChannelPage,
  guildId?: string,
) {
  return useSWR<ChannelPage>(
    K.channels(search),
    () =>
      browserApi.dashboard.channels({
        limit: 20,
        search: search || undefined,
        guildId,
      }) as Promise<ChannelPage>,
    { ...shared, fallbackData: initialData },
  );
}

export function useChannelDetail(
  channelId: string,
  initialData: ChannelDetail,
) {
  return useSWR<ChannelDetail>(
    K.channelDetail(channelId),
    () =>
      browserApi.dashboard.channelDetail(channelId) as Promise<ChannelDetail>,
    { ...shared, fallbackData: initialData },
  );
}

export function useTopReactions(limit: number, initialData: TopReaction[]) {
  return useSWR<TopReaction[]>(
    K.reactions(limit),
    () => browserApi.dashboard.reactions(limit) as Promise<TopReaction[]>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useTopReactors(limit: number, initialData: TopReactor[]) {
  return useSWR<TopReactor[]>(
    K.reactors(limit),
    () => browserApi.dashboard.reactors(limit) as Promise<TopReactor[]>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

// ── Messages ────────────────────────────────────────────────────────────────

export function useGuilds(initialData: Guild[]) {
  return useSWR<Guild[]>(
    K.guilds,
    () => browserApi.messages.guilds() as Promise<Guild[]>,
    {
      ...shared,
      fallbackData: initialData,
    },
  );
}

export function useTextChannels(
  guildId: string | null,
  initialData: TextChannel[],
) {
  return useSWR<TextChannel[]>(
    guildId ? K.textChannels(guildId) : null,
    () =>
      browserApi.messages.textChannels(guildId as string) as Promise<
        TextChannel[]
      >,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export function useMessages(query: MessageQuery, initialData: MessagePage) {
  return useSWR<MessagePage>(
    K.messagePage(query),
    () => browserApi.messages.list(query) as Promise<MessagePage>,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export function useReviewMessages(
  channelId: string | undefined,
  initialData: ReviewResult,
) {
  return useSWR<ReviewResult>(
    K.review(channelId),
    () =>
      browserApi.messages.review({
        limit: 20,
        channelId,
      }) as Promise<ReviewResult>,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export function useMessageActivity(days: number, initialData: ActivityCell[]) {
  return useSWR<ActivityCell[]>(
    K.messageActivity(days),
    () => browserApi.messages.activity(days) as Promise<ActivityCell[]>,
    { ...shared, fallbackData: initialData },
  );
}

export function useRecentEdits(
  channelId: string | undefined,
  initialData: MessageEdit[],
) {
  return useSWR<MessageEdit[]>(
    K.edits(channelId),
    () =>
      browserApi.messages.editHistory({
        limit: 50,
        channelId,
      }) as Promise<MessageEdit[]>,
    { ...shared, fallbackData: initialData },
  );
}

// ── Moderation ──────────────────────────────────────────────────────────────

export function useModerationStats(initialData: ModerationStats) {
  return useSWR<ModerationStats>(
    K.modStats,
    () => browserApi.moderation.stats() as Promise<ModerationStats>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useModerationActions(
  status: string,
  actionType: string,
  initialData: ModerationActionPage,
) {
  return useSWR<ModerationActionPage>(
    K.modActions(status, actionType),
    () =>
      browserApi.moderation.actions({
        limit: 50,
        status: status || undefined,
        actionType: actionType || undefined,
      }) as Promise<ModerationActionPage>,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export function useModerationTrends(
  days: number,
  initialData: ModerationTrends,
) {
  return useSWR<ModerationTrends>(
    K.modTrends(days),
    () => browserApi.moderation.trends(days) as Promise<ModerationTrends>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useFlaggedDomains(days: number, initialData: FlaggedDomain[]) {
  return useSWR<FlaggedDomain[]>(
    K.domains(days),
    () => browserApi.moderation.topDomains(days) as Promise<FlaggedDomain[]>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useFlaggedChannels(
  days: number,
  initialData: FlaggedChannel[],
) {
  return useSWR<FlaggedChannel[]>(
    K.flaggedChannels(days),
    () => browserApi.moderation.topChannels(days) as Promise<FlaggedChannel[]>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useHourlyModeration<T>(days: number, initialData: T) {
  return useSWR<T>(
    K.hourly(days),
    () => browserApi.moderation.byHour(days) as Promise<T>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

export function useCoverage<T>(days: number, initialData: T) {
  return useSWR<T>(
    K.coverage(days),
    () => browserApi.moderation.coverage(days) as Promise<T>,
    { ...shared, fallbackData: initialData, refreshInterval: LIVE },
  );
}

// ── Analysis / knowledge ────────────────────────────────────────────────────

export function useAnalysisSearch<T>(
  q: string,
  channelId: string | undefined,
  initialData: T,
) {
  return useSWR<T>(
    q ? K.search(q, channelId) : null,
    () =>
      browserApi.analysis.search({
        q,
        channelId,
        limit: 20,
      }) as Promise<T>,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export function useChannelCultures(
  search: string,
  initialData: ChannelCulture[],
) {
  return useSWR<ChannelCulture[]>(
    K.cultures(search),
    () =>
      browserApi.knowledge.channelCultures({
        limit: 50,
        search: search || undefined,
      }) as Promise<ChannelCulture[]>,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export function useGlossary(search: string, initialData: GlossaryTerm[]) {
  return useSWR<GlossaryTerm[]>(
    K.glossary(search),
    () =>
      browserApi.knowledge.glossary({
        limit: 50,
        search: search || undefined,
      }) as Promise<GlossaryTerm[]>,
    { ...shared, fallbackData: initialData, keepPreviousData: true },
  );
}

export type { Fetcher };
