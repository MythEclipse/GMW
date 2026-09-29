"use client";

import { getBrowserClient } from "@/lib/orpc/client";
import type { AppConfig } from "@/lib/types";
import type { RpcClient } from "@/lib/types/rpc";

/**
 * Browser-side data access over the `/trpc` WebSocket.
 *
 * Same procedure names as the server fetchers in `@/lib/api/server`, so a hook
 * can be re-pointed at either transport without the call site changing. The
 * page component seeds the cache with the SSR result and this client keeps it
 * fresh; it does not re-request what it already has.
 *
 * Must only be imported from a client component — it constructs a WebSocket.
 */
function client(): RpcClient {
  return getBrowserClient() as unknown as RpcClient;
}

export const browserApi = {
  dashboard: {
    stats: () => client().dashboard.stats({}),
    activity: (days: number) => client().dashboard.activity({ days }),
    users: (input: { limit?: number; cursor?: string; search?: string }) =>
      client().dashboard.users(input),
    userDetail: (userId: string) => client().dashboard.userDetail({ userId }),
    channels: (input: { limit?: number; search?: string; guildId?: string }) =>
      client().dashboard.channels(input),
    channelDetail: (channelId: string) =>
      client().dashboard.channelDetail({ channelId }),
    reactions: (limit: number) => client().dashboard.reactions({ limit }),
    reactors: (limit: number) => client().dashboard.reactors({ limit }),
  },
  messages: {
    guilds: () => client().messages.guilds({}),
    textChannels: (guildId: string) =>
      client().messages.textChannels({ guildId }),
    list: (query: Parameters<RpcClient["messages"]["list"]>[0]) =>
      client().messages.list(query),
    byChannel: (
      channelId: string,
      query: Parameters<RpcClient["messages"]["byChannel"]>[0]["query"],
    ) => client().messages.byChannel({ channelId, query }),
    detail: (id: string) => client().messages.detail({ id }),
    review: (input: { limit?: number; channelId?: string }) =>
      client().messages.review(input),
    activity: (days: number) => client().messages.activity({ days }),
    editHistory: (input: { limit?: number; channelId?: string }) =>
      client().messages.editHistory(input),
    images: (guildId: string, limit: number) =>
      client().messages.images({ guildId, limit }),
  },
  moderation: {
    stats: () => client().moderation.stats({}),
    actions: (input: {
      limit?: number;
      status?: string;
      actionType?: string;
    }) => client().moderation.actions(input),
    trends: (days: number) => client().moderation.trends({ days }),
    topDomains: (days: number) => client().moderation.topDomains({ days }),
    topChannels: (days: number) => client().moderation.topChannels({ days }),
    byHour: (days: number) => client().moderation.byHour({ days }),
    byCategory: (days: number, category: string) =>
      client().moderation.byCategory({ days, category }),
    coverage: (days: number) => client().moderation.coverage({ days }),
  },
  analysis: {
    search: (input: { q: string; channelId?: string; limit?: number }) =>
      client().analysis.search(input),
  },
  chatbot: {
    chat: (input: { message: string; context?: string; userId?: string }) =>
      client().chatbot.chat(input),
    history: (input: { limit?: number; userId?: string }) =>
      client().chatbot.history(input),
    clearHistory: (input: { userId?: string }) =>
      client().chatbot.clearHistory(input),
  },
  knowledge: {
    channelCultures: (input: { limit?: number; search?: string }) =>
      client().knowledge.channelCultures(input),
    glossary: (input: { limit?: number; search?: string }) =>
      client().knowledge.glossary(input),
  },
  config: {
    get: () => client().config.get({}),
    /**
     * The monitored guild, or null when none is configured OR the lookup
     * fails.
     *
     * The null-on-error half is load-bearing, not laziness: the deleted
     * `getDefaultGuildId` in `@/lib/api/server` wrapped `config.get` in a
     * try/catch for exactly this reason, so a config outage degrades to "no
     * guild scoping" instead of failing the whole page. Callers rely on null
     * being a supported, non-fatal state.
     */
    async defaultGuildId(): Promise<string | null> {
      try {
        const config = (await client().config.get({})) as AppConfig;
        return config.monitorGuildId ?? null;
      } catch {
        return null;
      }
    },
  },
  uiState: {
    get: () => client().uiState.get({}),
    update: (state: Record<string, unknown>) => client().uiState.update(state),
  },
};

export type BrowserApi = typeof browserApi;
