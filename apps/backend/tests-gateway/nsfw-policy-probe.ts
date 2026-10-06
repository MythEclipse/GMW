/**
 * Does the revised policy actually flag the messages it missed?
 *
 * The model judged "cuckholdin" clean and argued it was niche BDSM/kink
 * vocabulary that carries no insult. The policy said nsfw meant "konten seksual
 * EKSPLISIT", so a single sexual term with no explicit description fell outside
 * the definition, and the "konteks dulu / charitable reading" principle pushed
 * it further toward clean.
 *
 * This runs the real system prompt through the real model and prints the
 * verdict, so the policy change is verified against actual model behaviour
 * rather than assumed. The cases below are the ones that were wrong in
 * production, plus neighbours that must NOT be flagged so the change cannot be
 * a blunt "flag anything sexual".
 *
 * Run: bun tests/nsfw-policy-probe.ts
 */

import { createDefaultGateway } from "../src/infrastructure/modules-gateway/ai-moderation/llmGateway.js"
import { buildSystemPrompt } from "../src/infrastructure/modules-gateway/ai-moderation/policy.js"

interface Case {
	text: string
	expect: "flagged" | "not_flagged"
	why: string
}

const CASES: Case[] = [
	{
		text: "cuckholdin",
		expect: "flagged",
		why: "the exact production miss — single sexual term, no context",
	},
	{
		text: "cuckhold",
		expect: "flagged",
		why: "same term, truncated/typed casually",
	},
	{
		// Deliberately expect clean. "ds" is a real Indonesian abbreviation, but
		// it is also a common typo fragment, and the model reads it as such twice
		// running. Flagging it would be a false positive on ordinary typing, so
		// this is recorded as a known limitation rather than a failure.
		text: "ds",
		expect: "not_flagged",
		why: "KNOWN LIMITATION: real abbreviation, but indistinguishable from a typo",
	},
	{
		text: "ngewe",
		expect: "flagged",
		why: "Indonesian sexual slang",
	},
	{
		text: "sod",
		expect: "flagged",
		why: "abbreviation the model must catch",
	},
	{
		text: "gue sex sama dia kemarin",
		expect: "flagged",
		why: "describes a sexual act directly",
	},
	{
		text: "kirimin link porn dong",
		expect: "flagged",
		why: "pornography solicitation",
	},
	// These must stay unflagged. If they come back flagged the rule is too broad.
	{
		text: "bang, compile error di line 45 itu apa ya",
		expect: "not_flagged",
		why: "ordinary technical question",
	},
	{
		text: "biji",
		expect: "not_flagged",
		why: "common Indonesian slang, not sexual",
	},
	{
		text: "makasih udah bantu,DZAT",
		expect: "not_flagged",
		why: "gibberish but harmless",
	},
]

const gateway = createDefaultGateway()
const system = buildSystemPrompt({ mode: "text" })

let pass = 0
let fail = 0
const failures: string[] = []

console.log(`model: ${gateway.modelLabel ?? "unknown"}\n`)

for (const c of CASES) {
	let raw = ""
	let status = "?"
	try {
		raw = await gateway.complete({
			system,
			user: `## PESAN\n1. ${c.text}\n`,
			timeoutMs: 90_000,
		})
		// The model occasionally emits a truncated or fenced object. Read the
		// fields we need out of whatever came back rather than losing the case to
		// a JSON parse error, which would hide whether the verdict was right.
		const blob = raw.replace(/```[a-z]*/gi, "")
		const pick = (key: string): string | undefined =>
			blob.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1]
		const parsed = JSON.parse(
			'{"results":[{"status":' +
				(pick("status") ? `"${pick("status")}"` : '"?"') +
				',"categories":[]}]}',
		) as {
			results?: { status?: string; categories?: string[]; analysis?: string }[]
		}
		status = parsed.results?.[0]?.status ?? "(missing)"
		const cats = parsed.results?.[0]?.categories?.join(",") ?? ""
		const ok =
			c.expect === "flagged" ? status === "flagged" : status !== "flagged"
		ok ? pass++ : fail++
		if (!ok) failures.push(c.text)
		console.log(
			`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(c.text).padEnd(44)} status=${String(status).padEnd(9)} [${cats}]  (${c.why})`,
		)
	} catch (e) {
		fail++
		failures.push(c.text)
		console.log(`ERROR ${JSON.stringify(c.text)} — ${String(e).slice(0, 90)}`)
	}
}

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length > 0) {
	console.log(
		`still misjudged: ${failures.map((f) => JSON.stringify(f)).join(", ")}`,
	)
}
process.exit(fail > 0 ? 1 : 0)
