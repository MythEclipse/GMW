/**
 * Replays REAL production rows (390 messages, 82 of whose authors hold one of
 * the exempt roles) through the actual enforcement manager, to check the two
 * halves of the exemption separately:
 *
 *  1. A nickname violation on an exempt member: the reset is SKIPPED (Discord
 *     refuses `setNickname` with 50013 when the target's top role outranks the
 *     account's) and the message is KEPT — there is nothing wrong with the body.
 *
 *  2. A BODY violation on the same exempt member: the message is DELETED. The
 *     exemption is about the nickname only. Gating deletion on the role would
 *     exempt the server's admins from moderation entirely.
 *
 * The second half is the correction: an earlier version returned false from
 * `isEligibleForAutoDelete` for these members, so their messages were spared.
 *
 * Points `DATABASE_URL` at a dead port so the audit-row writes fail harmlessly
 * and PRODUCTION IS NOT TOUCHED — this probe observes decisions.
 *
 * Dump the input with:
 *   psql "$DATABASE_URL" -At -c "select json_agg(row_to_json(t)) from (select
 *     m.id, m.user_id, m.content, m.metadata::text as metadata from messages m
 *     order by m.created_at desc limit 390) t;" > rows.json
 *
 * Run:
 *   DATABASE_URL=postgres://localhost:6432/none \
 *   node_modules/.bin/tsx tests-gateway/exempt-role-enforcement-probe.ts ~/rows.json
 */
import { readFileSync } from "node:fs"
import { attemptAutoDeleteFlaggedMessage } from "../src/infrastructure/modules-gateway/ai-moderation/autoDeleteManager.js"

interface ProdRow {
	id: string
	user_id: string
	content: string | null
	metadata: string | null
}

const EXEMPT_ROLES = ["1504423881849442354", "1206223343905148959"]

const path = process.argv[2]
if (!path) {
	console.error("usage: exempt-role-enforcement-probe.ts <prod-rows.json>")
	process.exit(2)
}
const rows: ProdRow[] = JSON.parse(readFileSync(path, "utf8"))

function holdsExempt(row: ProdRow): boolean {
	if (typeof row.metadata !== "string") return false
	return EXEMPT_ROLES.some((id) => row.metadata?.includes(id))
}

/** A fresh identity per row, so the production cooldown never masks a reset. */
let seq = 0
function fakeClient() {
	const deleted: string[] = []
	const nicknames: Array<string | null> = []
	const member = {
		manageable: true,
		setNickname: async (v: string | null) => {
			nicknames.push(v)
		},
		// An EMPTY username, deliberately. `resetOffensiveNickname` re-reads the
		// member after the PATCH and asks the moderation model whether the global
		// username is ALSO offensive; a non-empty one would put a real LLM call
		// (10s timeout) on every row. The check starts `if (!username) return
		// false`, so an empty string keeps the probe offline and fast while
		// exercising the same code path.
		user: { id: "target", username: "" },
	}
	const channel = {
		permissionsFor: () => ({ has: () => true }),
		messages: {
			fetch: async (id: string) => ({
				delete: async () => {
					deleted.push(id)
				},
			}),
		},
		send: async () => undefined,
	}
	return {
		deleted,
		nicknames,
		client: {
			user: { id: "bot-self" },
			guilds: {
				cache: new Map([
					[
						"g1",
						{
							channels: { cache: new Map([["c1", channel]]) },
							members: { fetch: async () => member },
						},
					],
				]),
			},
		} as never,
	}
}

type Verdict = {
	status: string
	categories: string[]
	flags: string[]
	confidence: number
	analysis: string
}

const NAME_VERDICT: Verdict = {
	status: "deleted",
	categories: ["offensive_nickname"],
	flags: ["offensive_nickname"],
	confidence: 0.95,
	analysis: "Nickname melanggar aturan server; isi pesan bersih.",
}
const BODY_VERDICT: Verdict = {
	status: "deleted",
	categories: ["harassment"],
	flags: ["harassment"],
	confidence: 0.95,
	analysis: "hinaan langsung di isi pesan",
}

const tally = {
	exempt_rows: 0,
	plain_rows: 0,
	exempt_name_violation_reset_attempted: 0,
	exempt_name_violation_message_deleted: 0,
	exempt_body_violation_message_deleted: 0,
	exempt_body_violation_message_kept: [] as string[],
	plain_name_violation_reset_attempted: 0,
	plain_name_violation_message_deleted: [] as string[],
	plain_body_violation_message_deleted: 0,
	/**
	 * Rows where the manager's returned `deleted` flag did not match the Discord
	 * calls actually made. Must be empty: a manager that reported a skip while
	 * still deleting would be the worst version of the reported bug.
	 */
	result_disagreed_with_discord: [] as string[],
}

for (const row of rows) {
	seq += 1
	const isExempt = holdsExempt(row)
	if (isExempt) tally.exempt_rows += 1
	else tally.plain_rows += 1

	const base = {
		id: row.id,
		guild_id: "g1",
		channel_id: "c1",
		// Unique per row AND per scenario, so neither the cooldown nor the LRU
		// carries state between iterations.
		user_id: `${row.user_id}-probe${seq}`,
		thread_id: null,
		username: "probe",
		content: row.content,
		metadata: row.metadata,
	}

	// ── Scenario 1: the NAME is the violation ─────────────────────────
	{
		const { client, deleted, nicknames } = fakeClient()
		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			{ ...base },
			{ ...NAME_VERDICT },
		)
		// The ACTUAL Discord call, not just the manager's summary: a manager that
		// reported a skip while still deleting would be the worst version of this
		// bug, so the two are cross-checked rather than trusted.
		const reallyDeleted = deleted.length > 0
		if (reallyDeleted !== result.deleted) {
			tally.result_disagreed_with_discord.push(row.id)
		}
		if (isExempt) {
			if (nicknames.length > 0) tally.exempt_name_violation_reset_attempted += 1
			if (reallyDeleted) tally.exempt_name_violation_message_deleted += 1
		} else {
			if (nicknames.length > 0) tally.plain_name_violation_reset_attempted += 1
			if (reallyDeleted) tally.plain_name_violation_message_deleted.push(row.id)
		}
	}

	// ── Scenario 2: the BODY is the violation ─────────────────────────
	{
		const { client, deleted } = fakeClient()
		await attemptAutoDeleteFlaggedMessage(
			client,
			{ ...base, user_id: `${row.user_id}-body${seq}` },
			{ ...BODY_VERDICT },
		)
		const reallyDeleted = deleted.length > 0
		if (isExempt) {
			if (reallyDeleted) tally.exempt_body_violation_message_deleted += 1
			else tally.exempt_body_violation_message_kept.push(row.id)
		} else if (reallyDeleted) {
			tally.plain_body_violation_message_deleted += 1
		}
	}
}

console.log(JSON.stringify(tally, null, 2))
