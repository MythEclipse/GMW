import type { Metadata } from "next";
import {
  getCoverage,
  getFlaggedChannels,
  getFlaggedDomains,
  getHourlyModeration,
  getModerationActions,
  getModerationStats,
  getModerationTrends,
} from "@/lib/api/server";
import type { Coverage, HourBucket } from "@/lib/types";
import { ModerationView } from "./view";

export const metadata: Metadata = { title: "Moderation" };

const DAYS = 30;

export default async function ModerationPage() {
  const [stats, actions, trends, domains, flaggedChannels, hourly, coverage] =
    await Promise.all([
      getModerationStats(),
      getModerationActions({ limit: 50 }),
      getModerationTrends(DAYS),
      getFlaggedDomains(DAYS),
      getFlaggedChannels(DAYS),
      getHourlyModeration(DAYS),
      getCoverage(DAYS),
    ]);

  return (
    <ModerationView
      initialStats={stats}
      initialActions={actions}
      initialTrends={trends}
      initialDomains={domains}
      initialFlaggedChannels={flaggedChannels}
      initialHourly={hourly as HourBucket[]}
      initialCoverage={coverage as Coverage}
      days={DAYS}
    />
  );
}
