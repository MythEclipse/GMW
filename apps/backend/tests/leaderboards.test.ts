import { describe, expect, it } from "vitest"
import {
	buildLeaderboards,
	type LeaderboardRow,
} from "../src/domain/dashboard/leaderboards.js"

/**
 * The dashboard's leaderboards are the only place the app names individual
 * members, so a wrong reduction here is a wrong accusation shown to the guild.
 * These cases are the four ways it can be wrong without looking wrong: a rename
 * counted twice, a channel split by a missing name, a clean sender ranked as an
 * offender, and a hand-delete counted as a verdict.
 */

const meta = (channelName?: string) =>
	channelName === undefined
		? null
		: JSON.stringify({ channel: { channelName } })

function row(
	over: Partial<LeaderboardRow> & { user_id: string },
): LeaderboardRow {
	return {
		username: over.user_id,
		channel_id: "c1",
		metadata: meta("general"),
		created_at: 1,
		verdict_status: "clean",
		...over,
	}
}

describe("buildLeaderboards", () => {
	it("merges a rename into one member and shows their newest name", () => {
		const { most_active } = buildLeaderboards(
			[
				row({ user_id: "u1", username: "old_name", created_at: 1 }),
				row({ user_id: "u1", username: "new_name", created_at: 5 }),
				row({ user_id: "u1", username: "new_name", created_at: 3 }),
			],
			10,
		)

		expect(most_active).toHaveLength(1)
		expect(most_active[0]).toMatchObject({
			user_id: "u1",
			username: "new_name",
			total: 3,
		})
	})

	it("keeps a member with no stored username, labelled by id", () => {
		const { most_active } = buildLeaderboards(
			[row({ user_id: "u9", username: null })],
			10,
		)

		expect(most_active[0]).toMatchObject({ user_id: "u9", username: "u9" })
	})

	it("ranks offenders by deletions and leaves clean senders out", () => {
		const { top_offenders } = buildLeaderboards(
			[
				row({ user_id: "chatty", verdict_status: "clean" }),
				row({ user_id: "chatty", verdict_status: "clean" }),
				row({ user_id: "chatty", verdict_status: "clean" }),
				row({ user_id: "rude", verdict_status: "deleted" }),
				row({ user_id: "rude", verdict_status: "deleted" }),
				row({ user_id: "rude", verdict_status: "clean" }),
				row({ user_id: "loud", verdict_status: "deleted" }),
			],
			10,
		)

		expect(top_offenders.map((u) => [u.user_id, u.deleted, u.total])).toEqual([
			["rude", 2, 3],
			["loud", 1, 1],
		])
	})

	it("ranks activity by volume, not by deletions", () => {
		const { most_active } = buildLeaderboards(
			[
				row({ user_id: "chatty" }),
				row({ user_id: "chatty" }),
				row({ user_id: "chatty" }),
				row({ user_id: "rude", verdict_status: "deleted" }),
			],
			10,
		)

		expect(most_active.map((u) => [u.user_id, u.total])).toEqual([
			["chatty", 3],
			["rude", 1],
		])
	})

	it("counts a hand-delete as clean when the verdict says clean", () => {
		const { top_offenders } = buildLeaderboards(
			[row({ user_id: "u1", verdict_status: "clean" })],
			10,
		)

		expect(top_offenders).toEqual([])
	})

	it("merges a channel captured with and without its name", () => {
		const { problem_channels } = buildLeaderboards(
			[
				row({
					user_id: "u1",
					channel_id: "c1",
					metadata: null,
					created_at: 1,
					verdict_status: "deleted",
				}),
				row({
					user_id: "u1",
					channel_id: "c1",
					metadata: meta("general"),
					created_at: 2,
					verdict_status: "deleted",
				}),
			],
			10,
		)

		expect(problem_channels).toEqual([
			{ channel_id: "c1", channel_name: "general", total: 2, deleted: 2 },
		])
	})

	it("falls back to the channel id when no row ever carried a name", () => {
		const { problem_channels } = buildLeaderboards(
			[
				row({
					user_id: "u1",
					channel_id: "c7",
					metadata: null,
					verdict_status: "deleted",
				}),
			],
			10,
		)

		expect(problem_channels[0]?.channel_name).toBe("c7")
	})

	it("respects the limit without reordering", () => {
		const rows = ["a", "b", "c"].flatMap((id) =>
			Array.from({ length: id === "a" ? 3 : id === "b" ? 2 : 1 }, () =>
				row({ user_id: id }),
			),
		)

		expect(
			buildLeaderboards(rows, 2).most_active.map((u) => u.user_id),
		).toEqual(["a", "b"])
	})
})
