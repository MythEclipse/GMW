import type { Metadata } from "next";
import {
  getDefaultGuildId,
  getGuilds,
  getMessages,
  getRecentEdits,
  getReviewMessages,
  getTextChannels,
} from "@/lib/api/server";
import { MessagesView } from "./view";

export const metadata: Metadata = { title: "Messages" };

/**
 * Seed the page with the guild, its channels, the newest messages, the review
 * queue, and the recent-edit log.
 *
 * `getMessages` REQUIRES a guild or channel id, so when the archive is empty
 * (no `messages.guilds` row yet) the message list is skipped rather than
 * issuing a request the backend will reject with a ValidationError.
 */
export default async function MessagesPage() {
  const guilds = await getGuilds();
  const guildId = guilds[0]?.id ?? (await getDefaultGuildId());

  const [channels, review, edits] = await Promise.all([
    guildId ? getTextChannels(guildId) : Promise.resolve([]),
    getReviewMessages({ limit: 20 }),
    getRecentEdits({ limit: 25 }),
  ]);

  const messages = guildId
    ? await getMessages({ guildId, limit: 50 })
    : { data: [], nextCursor: null };

  return (
    <MessagesView
      initialGuilds={guilds}
      initialChannels={channels}
      initialMessages={messages.data}
      initialReview={review.results}
      initialEdits={edits}
      defaultGuildId={guildId}
    />
  );
}
