import type { Metadata } from "next";
import { getDefaultGuildId, searchAnalysis } from "@/lib/api/server";
import { AnalysisView } from "./view";

export const metadata: Metadata = { title: "Analysis" };

/**
 * The search runs against the monitored guild only (the backend injects
 * `MONITOR_GUILD_ID` itself), so no guild parameter is passed. The empty query
 * returns the most recent analysed messages, which gives the page content on
 * first load instead of a blank search box.
 */
export default async function AnalysisPage() {
  const [initial, guildId] = await Promise.all([
    searchAnalysis({ q: "", limit: 20 }),
    getDefaultGuildId(),
  ]);

  return <AnalysisView initialResults={initial.results} guildId={guildId} />;
}
