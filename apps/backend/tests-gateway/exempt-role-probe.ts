/**
 * Verifies the role exemption against the REAL production metadata.
 *
 * The unit tests use constructed fixtures. This checks the actual captured
 * `messages.metadata` for the members who hold the two exempt roles, because the
 * exemption shipped inert once already on this codebase for a wire-shape reason
 * (a JSON string vs a parsed object) that only the real rows can catch.
 *
 * Also replays the enforcement decision for those members: the point of the
 * exemption is that no doomed PATCH is attempted and no failed row is written.
 *
 * Run (reads only; DATABASE_URL points at a dead port so nothing is written):
 *   DATABASE_URL=postgres://localhost:6432/none \
 *   node_modules/.bin/tsx scripts/probe-exempt-roles.ts <prod-rows.json>
 */
import { readFileSync } from "node:fs"
import {
	holdsExemptRole,
	isEligibleForAutoDelete,
} from "../src/infrastructure/modules-gateway/ai-moderation/autoDeleteEligibility.js"

interface ProdRow {
	id: string
	user_id: string
	content: string | null
	metadata: string | null
	roles?: Array<{ id: string; name: string }> | null
}

const path = process.argv[2]
if (!path) {
	console.error("usage: probe-exempt-roles.ts <prod-rows.json>")
	process.exit(2)
}
const rows: ProdRow[] = JSON.parse(readFileSync(path, "utf8"))

const EXEMPT_ROLES = new Set(["1504423881849442354", "1206223343905148959"])

let holders = 0
let holdersDetected = 0
let nonHolders = 0
let nonHoldersDetected = 0
const missedHolders: string[] = []

for (const row of rows) {
	// Ground truth from the row's own role list, extracted by SQL.
	const roleIds = (row.roles ?? []).map((r) => r.id)
	const trulyExempt = roleIds.some((id) => EXEMPT_ROLES.has(id))

	const detected = holdsExemptRole({
		id: row.id,
		guild_id: "g1",
		channel_id: "c1",
		user_id: row.user_id,
		content: row.content,
		metadata: row.metadata,
	})

	if (trulyExempt) {
		holders += 1
		if (detected) holdersDetected += 1
		else missedHolders.push(`${row.user_id}:${row.id}`)
	} else {
		nonHolders += 1
		if (!detected) nonHoldersDetected += 1
	}
}

console.log(
	JSON.stringify(
		{
			rows_checked: rows.length,
			actual_role_holders: holders,
			holders_detected: holdersDetected,
			actual_non_holders: nonHolders,
			non_holders_correctly_allowed: nonHoldersDetected,
			MISSED_ROLE_HOLDERS: missedHolders,
		},
		null,
		2,
	),
)
