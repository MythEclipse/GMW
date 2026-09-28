import type { Metadata } from "next";
import {
  getActivity,
  getStats,
  getTopReactions,
  getTopReactors,
} from "@/lib/api/server";
import { DashboardView } from "./view";

export const metadata: Metadata = { title: "Overview" };

const DAYS = 14;

/**
 * Server component: fetches the seed data, hands it to the client view.
 *
 * Everything here is `no-store`, so the first paint already shows live numbers
 * and the client hook continues from exactly this payload.
 */
export default async function DashboardPage() {
  // Independent reads, so they go in parallel rather than in sequence.
  const [stats, activity, reactions, reactors] = await Promise.all([
    getStats(),
    getActivity(DAYS),
    getTopReactions(10),
    getTopReactors(10),
  ]);

  return (
    <DashboardView
      initialStats={stats}
      initialActivity={activity}
      initialReactions={reactions}
      initialReactors={reactors}
      days={DAYS}
    />
  );
}
