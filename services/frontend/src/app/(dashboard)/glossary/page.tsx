"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type { ChannelCulture, FlaggedDomain, GlossaryTerm } from "@/lib/types";
import { GlossaryView } from "./view";

const DAYS = 30;

/**
 * Client route for /glossary — was a server component issuing three parallel
 * oRPC calls. Props unchanged.
 */
export function GlossaryPage() {
  const fetcher = useCallback(async () => {
    const [cultures, glossary, domains] = await Promise.all([
      browserApi.knowledge.channelCultures({
        limit: 50,
      }) as unknown as Promise<ChannelCulture[]>,
      browserApi.knowledge.glossary({
        limit: 50,
      }) as unknown as Promise<GlossaryTerm[]>,
      browserApi.moderation.topDomains(DAYS) as unknown as Promise<
        FlaggedDomain[]
      >,
    ]);

    return {
      cultures: cultures ?? [],
      glossary: glossary ?? [],
      domains: domains ?? [],
    };
  }, []);

  const seed = useRouteSeed(fetcher);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading glossary" />;
  }

  return (
    <GlossaryView
      initialCultures={seed.data.cultures}
      initialGlossary={seed.data.glossary}
      initialDomains={seed.data.domains}
    />
  );
}
