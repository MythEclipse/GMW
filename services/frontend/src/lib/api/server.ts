import "server-only";

import { serverClient } from "@/lib/orpc/server";
import type {
  ActivityCell,
  AppConfig,
  ChannelCulture,
  ChannelDetail,
  ChannelPage,
  DashboardActivity,
  DashboardStats,
  FlaggedChannel,
  FlaggedDomain,
  GlossaryTerm,
  Guild,
  HourBucket,
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
  UiState,
  UserPage,
} from "@/lib/types";
import type { AnalysisSearchResult } from "@/lib/types/rpc";

/**
 * Server-side data fetchers used by React Server Components to seed each page.
 *
 * Every call is `cache: "no-store"` (see the RPCLink) and every result is cast
 * to a locally-owned type from `@/lib/types`. The backend's `AppRouter` type is
 * deliberately not imported: the services deploy independently, and a backend
 * field addition must not break the frontend typecheck.
 *
 * These functions are intentionally thin. If a fetch throws, the error reaches
 * the route's `error.tsx` boundary with a retry affordance, rather than being
 * swallowed into a half-empty dashboard that looks healthy.
 */

// ── Dashboard ───────────────────────────────────────────────────────────────

export async function getStats(): Promise<DashboardStats> {
  return (await serverClient.dashboard.stats({})) as unknown as DashboardStats;
}

export async function getActivity(days = 14): Promise<DashboardActivity> {
  return (await serverClient.dashboard.activity({
    days,
  })) as unknown as DashboardActivity;
}

export async function getUsers(
  options: { limit?: number; cursor?: string; search?: string } = {},
): Promise<UserPage> {
  return (await serverClient.dashboard.users({
    limit: options.limit ?? 20,
    cursor: options.cursor,
    search: options.search,
  })) as unknown as UserPage;
}

export async function getUserDetail(userId: string) {
  return (await serverClient.dashboard.userDetail({ userId })) as unknown;
}

export async function getChannels(
  options: { limit?: number; search?: string; guildId?: string } = {},
): Promise<ChannelPage> {
  return (await serverClient.dashboard.channels({
    limit: options.limit ?? 20,
    search: options.search,
    guildId: options.guildId,
  })) as unknown as ChannelPage;
}

export async function getChannelDetail(
  channelId: string,
): Promise<ChannelDetail> {
  return (await serverClient.dashboard.channelDetail({
    channelId,
  })) as unknown as ChannelDetail;
}

export async function getTopReactions(limit = 20): Promise<TopReaction[]> {
  return (await serverClient.dashboard.reactions({
    limit,
  })) as unknown as TopReaction[];
}

export async function getTopReactors(limit = 20): Promise<TopReactor[]> {
  return (await serverClient.dashboard.reactors({
    limit,
  })) as unknown as TopReactor[];
}

// ── Messages ────────────────────────────────────────────────────────────────

export async function getGuilds(): Promise<Guild[]> {
  return (await serverClient.messages.guilds({})) as unknown as Guild[];
}

export async function getTextChannels(guildId: string): Promise<TextChannel[]> {
  return (await serverClient.messages.textChannels({
    guildId,
  })) as unknown as TextChannel[];
}

/**
 * The backend REQUIRES either channelId or guildId; a bare list is a
 * ValidationError. Callers that have neither must not call this.
 */
export async function getMessages(query: MessageQuery): Promise<MessagePage> {
  return (await serverClient.messages.list({
    ...query,
  })) as unknown as MessagePage;
}

export async function getMessagesByChannel(
  channelId: string,
  query: MessageQuery,
): Promise<MessagePage> {
  return (await serverClient.messages.byChannel({
    channelId,
    query,
  })) as unknown as MessagePage;
}

export async function getMessageDetail(id: string) {
  return (await serverClient.messages.detail({ id })) as unknown;
}

export async function getImageMessages(guildId: string, limit = 50) {
  return (await serverClient.messages.images({
    guildId,
    limit,
  })) as unknown;
}

export async function getReviewMessages(
  options: { limit?: number; channelId?: string } = {},
): Promise<ReviewResult> {
  return (await serverClient.messages.review({
    limit: options.limit ?? 20,
    channelId: options.channelId,
  })) as unknown as ReviewResult;
}

export async function getMessageActivity(days = 30): Promise<ActivityCell[]> {
  return (await serverClient.messages.activity({
    days,
  })) as unknown as ActivityCell[];
}

export async function getRecentEdits(
  options: { limit?: number; channelId?: string } = {},
): Promise<MessageEdit[]> {
  return (await serverClient.messages.editHistory({
    limit: options.limit ?? 50,
    channelId: options.channelId,
  })) as unknown as MessageEdit[];
}

// ── Moderation ──────────────────────────────────────────────────────────────

export async function getModerationStats(): Promise<ModerationStats> {
  return (await serverClient.moderation.stats(
    {},
  )) as unknown as ModerationStats;
}

export async function getModerationActions(
  options: { limit?: number; status?: string; actionType?: string } = {},
): Promise<ModerationActionPage> {
  return (await serverClient.moderation.actions({
    limit: options.limit ?? 50,
    status: options.status,
    actionType: options.actionType,
  })) as unknown as ModerationActionPage;
}

export async function getModerationTrends(
  days = 30,
): Promise<ModerationTrends> {
  return (await serverClient.moderation.trends({
    days,
  })) as unknown as ModerationTrends;
}

export async function getFlaggedDomains(days = 30): Promise<FlaggedDomain[]> {
  return (await serverClient.moderation.topDomains({
    days,
  })) as unknown as FlaggedDomain[];
}

export async function getFlaggedChannels(days = 30): Promise<FlaggedChannel[]> {
  return (await serverClient.moderation.topChannels({
    days,
  })) as unknown as FlaggedChannel[];
}

export async function getHourlyModeration(days = 30): Promise<HourBucket[]> {
  return (await serverClient.moderation.byHour({
    days,
  })) as unknown as HourBucket[];
}

export async function getByCategory(
  days: number,
  category: string,
): Promise<unknown[]> {
  return (await serverClient.moderation.byCategory({
    days,
    category,
  })) as unknown as unknown[];
}

export async function getCoverage(days = 30) {
  return (await serverClient.moderation.coverage({ days })) as unknown;
}

// ── Analysis / knowledge / config ───────────────────────────────────────────

export async function searchAnalysis(options: {
  q: string;
  channelId?: string;
  limit?: number;
}): Promise<AnalysisSearchResult> {
  return (await serverClient.analysis.search({
    q: options.q,
    channelId: options.channelId,
    limit: options.limit ?? 20,
  })) as AnalysisSearchResult;
}

export async function getChannelCultures(
  options: { limit?: number; search?: string } = {},
): Promise<ChannelCulture[]> {
  return (await serverClient.knowledge.channelCultures({
    limit: options.limit ?? 50,
    search: options.search,
  })) as unknown as ChannelCulture[];
}

export async function getGlossary(
  options: { limit?: number; search?: string } = {},
): Promise<GlossaryTerm[]> {
  return (await serverClient.knowledge.glossary({
    limit: options.limit ?? 50,
    search: options.search,
  })) as unknown as GlossaryTerm[];
}

export async function getConfig(): Promise<AppConfig> {
  return (await serverClient.config.get({})) as AppConfig;
}

export async function getUiState(): Promise<UiState> {
  return (await serverClient.uiState.get({})) as UiState;
}

/** Convenience for the pickers: the monitored guild, if one is configured. */
export async function getDefaultGuildId(): Promise<string | null> {
  try {
    const config = await getConfig();
    return config.monitorGuildId ?? null;
  } catch {
    return null;
  }
}
