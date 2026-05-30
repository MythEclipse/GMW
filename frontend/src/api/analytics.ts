import { request } from "./client";

export interface ViolatorStat {
  user_id: string;
  username: string;
  avatar_url: string | null;
  total_messages: number;
  flagged_count: number;
  warned_count: number;
  violation_score: number;
  worst_flags: string[];
  last_violation: number;
}

export interface HourlyBucket {
  hour: string;
  count: number;
  clean: number;
  warned: number;
  flagged: number;
  error: number;
}

export interface TopicTrend {
  topic: string;
  count: number;
  score: number;
}

export interface UserStat {
  user_id: string;
  username: string;
  avatar_url: string | null;
  message_count: number;
  edited_count: number;
  deleted_count: number;
  flagged_count: number;
  last_active: number;
}

export interface ModerationBreakdown {
  total: number;
  clean: number;
  warned: number;
  flagged: number;
  error: number;
  pending: number;
  average_score: number;
}

export interface AnalyticsOverview {
  period: { start: number; end: number };
  messages: ModerationBreakdown;
  hourly: HourlyBucket[];
  topics: TopicTrend[];
  top_users: UserStat[];
  active_users_count: number;
  total_channels: number;
}

export async function fetchAnalyticsOverview(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<AnalyticsOverview> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
  });
  return request<AnalyticsOverview>(`/api/analytics/overview?${searchParams}`);
}

export async function fetchHourlyStats(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<HourlyBucket[]> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
  });
  return request<HourlyBucket[]>(`/api/analytics/hourly?${searchParams}`);
}

export async function fetchTopicTrends(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<TopicTrend[]> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
  });
  return request<TopicTrend[]>(`/api/analytics/topics?${searchParams}`);
}

export async function fetchLeaderboard(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
  limit?: number;
}): Promise<UserStat[]> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
    ...(params.limit && { limit: String(params.limit) }),
  });
  return request<UserStat[]>(`/api/analytics/leaderboard?${searchParams}`);
}

export async function fetchModerationStats(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<ModerationBreakdown> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
  });
  return request<ModerationBreakdown>(`/api/analytics/stats?${searchParams}`);
}

export async function fetchViolators(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
  limit?: number;
}): Promise<ViolatorStat[]> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
    ...(params.limit && { limit: String(params.limit) }),
  });
  return request<ViolatorStat[]>(`/api/analytics/violators?${searchParams}`);
}

export interface TrendBucket {
  date: string;
  count: number;
  clean: number;
  warned: number;
  flagged: number;
  error: number;
}

export interface HeatmapCell {
  dayOfWeek: number;
  hour: number;
  count: number;
  clean: number;
  warned: number;
  flagged: number;
}

export async function fetchTrend(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<TrendBucket[]> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
  });
  return request<TrendBucket[]>(`/api/analytics/trend?${searchParams}`);
}

export async function fetchHeatmap(params: {
  guildId: string;
  channelId?: string;
  hours?: number;
}): Promise<HeatmapCell[]> {
  const searchParams = new URLSearchParams({
    guildId: params.guildId,
    ...(params.channelId && { channelId: params.channelId }),
    ...(params.hours && { hours: String(params.hours) }),
  });
  return request<HeatmapCell[]>(`/api/analytics/heatmap?${searchParams}`);
}
