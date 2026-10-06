/**
 * Does a message the policy now calls a violation actually become eligible for
 * deletion?
 *
 * `status = deleted` is necessary but not sufficient: the gate also requires
 * confidence >= AUTO_DELETE_MIN_CONFIDENCE (default 0.5), evidence the message
 * was actually readable (no SUPPRESS_EMBEDS, no bare link with an unresolved
 * preview), and a category the operator allows. A policy fix that raised
 * confidence to 0.99 on a message whose content was never captured would
 * change the dashboard and delete nothing — the same class of silent failure as
 * the broken claim query.
 *
 * This runs the real prompt through the real model and then feeds the verdict
 * through the real gate, so the whole path is exercised.
 *
 * Run: bun tests/nsfw-eligibility-probe.ts
 */

import { isEligibleForAutoDelete } from "../src/infrastructure/modules-gateway/ai-moderation/autoDeleteEligibility.js"
import { createDefaultGateway } from "../src/infrastructure/modules-gateway/ai-moderation/llmGateway.js"
import { buildSystemPrompt } from "../src/infrastructure/modules-gateway/ai-moderation/policy.js"

const gateway = createDefaultGateway()
const system = buildSystemPrompt({ mode: "text" })

// Minimal message row: the gate reads these for legacy fields and ids only.
const message = {
	id: "probe",
	guild_id: "1",
	channel_id: "1",
	user_id: "1",
	content: "",
	deleted_at: null,
}

interface Case {
	text: string
	// 'delete' = must pass the gate; 'keep' = must be refused by the gate.
	expect: "delete" | "keep"
	why: string
}

const CASES: Case[] = [
	{ text: "cuckholdin", expect: "delete", why: "the production miss" },
	{
		text: "kirimin link porn dong",
		expect: "delete",
		why: "explicit solicitation",
	},
	{ text: "ngewe", expect: "delete", why: "sexual slang on its own" },
	{ text: "sod", expect: "delete", why: "abbreviation" },
	{
		text: "biji",
		expect: "keep",
		why: "vulgar but not sexual — must not be deleted",
	},
	{
		text: "bang, compile error di line 45",
		expect: "keep",
		why: "ordinary technical chatter — must not be deleted",
	},
]

let pass = 0
let fail = 0

for (const c of CASES) {
	try {
		const raw = await gateway.complete({
			system,
			user: `## PESAN\n1. ${c.text}\n`,
			timeoutMs: 90_000,
		})
		const blob = raw.replace(/```[a-z]*/gi, "")
		// Numeric fields (confidence, score) have no quotes around the
		// value, so the quoted-key regex misses them. Parse them
		// separately.
		const pick = (key: string): string | undefined =>
			blob.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1]
		const pickNum = (key: string): number => {
			const m = blob.match(new RegExp(`"${key}"\\s*:\\s*([0-9.]+)`))
			return m ? Number(m[1]) : NaN
		}
		const status = pick("status") ?? "?"
		// `reason` replaced severity + recommended_action: it is now the only
		// record of why a message was removed, and the gate reads it as text.
		const reason = pick("reason") ?? ""
		const conf = pickNum("confidence") || pickNum("score") || 0

		const verdict = {
			message_id: "probe",
			status,
			reason,
			confidence: Number.isFinite(conf) ? conf : 0,
			score: Number(pick("score") ?? "0") || 0,
			categories: (pick("categories") ?? "").split(",").filter(Boolean),
			flags: [],
			analysis: "",
			created_at: String(Date.now()),
			auto_delete_state: null,
		}

		const eligible = isEligibleForAutoDelete(message as never, verdict as never)
		const ok = c.expect === "delete" ? eligible : !eligible
		ok ? pass++ : fail++
		console.log(
			`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text).padEnd(34)} status=${String(status).padEnd(9)} conf=${conf.toFixed(2)} eligible=${String(eligible).padEnd(5)}  (${c.why})`,
		)
	} catch (e) {
		fail++
		console.log(`ERROR ${JSON.stringify(c.text)} — ${String(e).slice(0, 100)}`)
	}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
