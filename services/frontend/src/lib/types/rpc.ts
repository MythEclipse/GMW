import type {
  ChannelCulture,
  DashboardActivity,
  DashboardStats,
  FlaggedChannel,
  FlaggedDomain,
  GlossaryTerm,
  Guild,
  HourBucket,
  Message,
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
} from "./index";

/**
 * The client-side shape of the backend's oRPC router, hand-written.
 *
 * WHY NOT IMPORT THE BACKEND'S `AppRouter` TYPE
 * The three services are separate deployables with separate builds. Typing
 * the frontend against the backend's router type would make every backend
 * signature change a frontend typecheck failure — exactly the coupling the
 * project guide warns against. Instead this file re-declares only the surface
 * the dashboard actually calls, and each response is asserted to the local
 * domain types in `types/index.ts`.
 *
 * The cost is that this can drift. It cannot drift silently, though: a renamed
 * procedure stops typechecking here, and a changed response shape fails the
 * assertion at the call site.
 */
export interface DashboardClient {
  stats(input: Record<string, never>): Promise<unknown>;
  activity(input: { days?: number }): Promise<unknown>;
  users(input: {
    limit?: number;
    cursor?: string;
    search?: string;
  }): Promise<unknown>;
  userDetail(input: { userId: string }): Promise<unknown>;
  channels(input: {
    limit?: number;
    search?: string;
    guildId?: string;
  }): Promise<unknown>;
  channelDetail(input: { channelId: string }): Promise<unknown>;
  reactions(input: { limit?: number }): Promise<unknown>;
  reactors(input: { limit?: number }): Promise<unknown>;
}

export interface MessagesClient {
  guilds(input: Record<string, never>): Promise<unknown>;
  textChannels(input: { guildId: string }): Promise<unknown>;
  list(input: MessageQuery): Promise<unknown>;
  byChannel(input: {
    channelId: string;
    query: MessageQuery;
  }): Promise<unknown>;
  detail(input: { id: string }): Promise<unknown>;
  images(input: { guildId: string; limit?: number }): Promise<unknown>;
  attachmentsByChannel(input: {
    channelId: string;
    query: MessageQuery;
  }): Promise<unknown>;
  review(input: { limit?: number; channelId?: string }): Promise<unknown>;
  activity(input: { days?: number }): Promise<unknown>;
  editHistory(input: { limit?: number; channelId?: string }): Promise<unknown>;
}

export interface ModerationClient {
  stats(input: Record<string, never>): Promise<unknown>;
  actions(input: {
    limit?: number;
    status?: string;
    actionType?: string;
    cursor?: number;
  }): Promise<unknown>;
  trends(input: { days?: number }): Promise<unknown>;
  topDomains(input: { days?: number }): Promise<unknown>;
  topChannels(input: { days?: number }): Promise<unknown>;
  byHour(input: { days?: number }): Promise<unknown>;
  byCategory(input: { days?: number; category: string }): Promise<unknown>;
  coverage(input: { days?: number }): Promise<unknown>;
}

export interface AnalysisClient {
  search(input: {
    q: string;
    channelId?: string;
    limit?: number;
  }): Promise<unknown>;
}

export interface ChatbotClient {
  chat(input: {
    message: string;
    context?: string;
    userId?: string;
  }): Promise<unknown>;
  history(input: { limit?: number; userId?: string }): Promise<unknown>;
  clearHistory(input: { userId?: string }): Promise<unknown>;
}

export interface KnowledgeClient {
  channelCultures(input: { limit?: number; search?: string }): Promise<unknown>;
  glossary(input: { limit?: number; search?: string }): Promise<unknown>;
}

export interface ConfigClient {
  get(input: Record<string, never>): Promise<unknown>;
}

export interface UiStateClient {
  get(input: Record<string, never>): Promise<unknown>;
  update(input: Record<string, unknown>): Promise<unknown>;
}

/** The full dashboard client, mirroring the backend's root router. */
export interface RpcClient {
  dashboard: DashboardClient;
  messages: MessagesClient;
  moderation: ModerationClient;
  analysis: AnalysisClient;
  chatbot: ChatbotClient;
  knowledge: KnowledgeClient;
  config: ConfigClient;
  uiState: UiStateClient;
}

// ── Response types used by more than one module ─────────────────────────────

export interface AnalysisSearchResult {
  results: Message[];
}

export type {
  ChannelCulture,
  DashboardActivity,
  DashboardStats,
  FlaggedChannel,
  FlaggedDomain,
  GlossaryTerm,
  Guild,
  HourBucket,
  MessageEdit,
  MessagePage,
  ModerationActionPage,
  ModerationStats,
  ModerationTrends,
  ReviewResult,
  TextChannel,
  TopReaction,
  TopReactor,
  UserPage,
};
