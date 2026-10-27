import { readChannelName } from "../utils/channelName.js"

/**
 * Leaderboards for the dashboard: who the model deletes, who posts most, and
 * which channels carry the deletions.
 *
 * The reduction lives in `domain/` rather than in the repository because this is
 * the part with rules in it, and the rules have to be provable without a
 * database. The repository's only job is to hand over one flat row per message.
 *
 * Four decisions, each one a way the naive version reads wrong:
 *
 *  - **A member is a `user_id`, not a username.** Grouping by
 *    (user_id, username) splits a member who renamed into two rows, so one
 *    offender appears twice and neither row is their real total. The displayed
 *    name is the one from their newest message, so the row shows who they are
 *    now.
 *  - **A channel is a `channel_id`.** The name lives in `messages.metadata`, and
 *    a message captured without it must not become a second bucket for the same
 *    channel. `getStats().top_channels` deliberately keeps those apart (it
 *    reproduces the old GROUP BY key exactly); a leaderboard must not, because
 *    there is no legacy number to stay faithful to.
 *  - **"Deleted" is the verdict, not `messages.deleted_at`.** A moderator
 *    deleting something by hand is not the model's finding, and this panel ranks
 *    the model's findings.
 *  - **Members with nothing deleted are not offenders.** A "top offenders" list
 *    padded with clean senders would be a lie told by sorting.
 */

/** One row per message: the only shape the reduction needs. */
export interface LeaderboardRow {
	user_id: string
	username: string | null
	channel_id: string
	metadata: string | null
	created_at: number
	verdict_status: string | null
}

export interface UserLeaderboardEntry {
	user_id: string
	username: string
	/** Messages this member sent. */
	total: number
	/** How many of them the model deleted. */
	deleted: number
}

export interface ChannelLeaderboardEntry {
	channel_id: string
	channel_name: string
	total: number
	deleted: number
}

export interface Leaderboards {
	top_offenders: UserLeaderboardEntry[]
	most_active: UserLeaderboardEntry[]
	problem_channels: ChannelLeaderboardEntry[]
}

/** Both rankings sort the same counts, in opposite order of emphasis. */
type Counts = { total: number; deleted: number }

const byDeleted = (a: Counts, b: Counts) =>
	b.deleted - a.deleted || b.total - a.total
const byTotal = (a: Counts, b: Counts) =>
	b.total - a.total || b.deleted - a.deleted

export function buildLeaderboards(
	rows: readonly LeaderboardRow[],
	limit: number,
): Leaderboards {
	const users = new Map<string, UserLeaderboardEntry>()
	const channels = new Map<string, ChannelLeaderboardEntry>()
	// Newest timestamp seen per key, kept beside the entry rather than inside it
	// so the payload never carries a field that exists only for bookkeeping.
	const userSeen = new Map<string, number>()
	const channelSeen = new Map<string, number>()

	for (const row of rows) {
		const deleted = row.verdict_status === "deleted" ? 1 : 0

		const user = users.get(row.user_id) ?? {
			user_id: row.user_id,
			// A member with no stored username is still a row on this list; their
			// id is the only honest label left.
			username: row.username ?? row.user_id,
			total: 0,
			deleted: 0,
		}
		user.total += 1
		user.deleted += deleted
		// Strictly newer, so among equal timestamps the row the query returned
		// first wins. The repository orders newest-first, which makes the result
		// stable without a second tie-breaker on the name.
		const seenUser = userSeen.get(row.user_id)
		if (row.username && (seenUser === undefined || row.created_at > seenUser)) {
			user.username = row.username
			userSeen.set(row.user_id, row.created_at)
		}
		users.set(row.user_id, user)

		const channel = channels.get(row.channel_id) ?? {
			channel_id: row.channel_id,
			channel_name: row.channel_id,
			total: 0,
			deleted: 0,
		}
		channel.total += 1
		channel.deleted += deleted
		const seenChannel = channelSeen.get(row.channel_id)
		if (seenChannel === undefined || row.created_at > seenChannel) {
			channel.channel_name = readChannelName(row.metadata) ?? row.channel_id
			channelSeen.set(row.channel_id, row.created_at)
		}
		channels.set(row.channel_id, channel)
	}

	const rankedUsers = [...users.values()]

	return {
		top_offenders: [...rankedUsers]
			.filter((u) => u.deleted > 0)
			.sort(byDeleted)
			.slice(0, limit),
		// Everyone who posted, deleted or not — this list answers "who is
		// carrying the conversation", not "who is a problem".
		most_active: [...rankedUsers].sort(byTotal).slice(0, limit),
		problem_channels: [...channels.values()]
			.filter((c) => c.deleted > 0)
			.sort(byDeleted)
			.slice(0, limit),
	}
}
