/**
 * Replays the 51 real production `reset_nickname` verdicts through the actual
 * enforcement manager and reports what the fix DOES, not what a predicate says.
 *
 * Reads a JSON dump of the rows (see the `psql` one-liner in the note below)
 * rather than the live database, and points `DATABASE_URL` at a dead port, so
 * the audit-row writes fail harmlessly and PRODUCTION IS NOT TOUCHED. That is
 * deliberate: this probe observes decisions, and a probe that borrowed the real
 * store's tables would add 51 fake rows to the very audit trail it is checking.
 *
 * Dump the input with:
 *   psql "$DATABASE_URL" -At -c "select json_agg(row_to_json(t)) from (select
 *     m.id, m.user_id, m.content, m.metadata::text as metadata, v.action,
 *     v.status, v.flags, v.categories, v.confidence, v.score, v.analysis,
 *     m.deleted_at from verdicts v join messages m on m.id = v.message_id
 *     where v.action = 'reset_nickname' order by v.created_at desc) t;" > rows.json
 *
 * Run:
 *   DATABASE_URL=postgres://localhost:6432/none \
 *   node_modules/.bin/tsx scripts/probe-nickname-manager.ts ~/rows.json
 */
import { readFileSync } from "node:fs"
import { attemptAutoDeleteFlaggedMessage } from "../src/infrastructure/modules-gateway/ai-moderation/autoDeleteManager.js"

interface ProdRow {
	id: string
	user_id: string
	content: string | null
	metadata: string | null
	action: string | null
	status: string
	flags: string[] | null
	categories: string[] | null
	confidence: number | null
	score: number | null
	analysis: string | null
	deleted_at: number | null
}

const path = process.argv[2]
if (!path) {
	console.error("usage: probe-nickname-manager.ts <prod-rows.json>")
	process.exit(2)
}
const rows: ProdRow[] = JSON.parse(readFileSync(path, "utf8"))

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
		user: { id: "target", username: "someuser" },
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

let kept = 0
let removed = 0
let resetIssued = 0
let resetSkipped = 0
const deletedWithoutReset: string[] = []
const wronglyDeleted: string[] = []
const reasons = new Map<string, number>()

for (const row of rows) {
	seq += 1
	const { client, deleted, nicknames } = fakeClient()
	const result = await attemptAutoDeleteFlaggedMessage(
		client,
		{
			id: row.id,
			guild_id: "g1",
			channel_id: "c1",
			user_id: `${row.user_id}-probe${seq}`,
			thread_id: null,
			username: "probe",
			content: row.content,
			metadata: row.metadata,
		},
		{
			status: row.status,
			action: row.action,
			flags: row.flags ?? [],
			categories: row.categories ?? [],
			confidence: row.confidence,
			score: row.score,
			analysis: row.analysis,
		},
	)

	if (result.deleted) removed += 1
	else kept += 1
	if (nicknames.length > 0) resetIssued += 1
	else resetSkipped += 1
	reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1)

	// The exact shape of the reported bug: message gone, name untouched.
	if (result.deleted && nicknames.length === 0) deletedWithoutReset.push(row.id)
	// The rows that were deleted in prod over a nickname: do we still delete them?
	if (row.deleted_at !== null && result.deleted) wronglyDeleted.push(row.id)
}

console.log(
	JSON.stringify(
		{
			replayed: rows.length,
			message_kept: kept,
			message_deleted: removed,
			nickname_patch_issued: resetIssued,
			nickname_patch_skipped: resetSkipped,
			deleted_without_reset: deletedWithoutReset.length,
			messages_deleted_in_prod_that_would_still_be_deleted:
				wronglyDeleted.length,
			reasons: Object.fromEntries(reasons),
		},
		null,
		2,
	),
)
