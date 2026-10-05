/**
 * Live probe: the real KBBI service, through the real built adapter.
 *
 * Runs against dist/ rather than src/ so it exercises the artifact the
 * deploy script actually ships (tsc + fix-imports), not the uncompiled
 * source.
 *
 * Usage: bun tests/kbbi-live-probe.ts
 */

import { selectBatchDictionaryWords } from "../dist/modules/ai-moderation/dictionary-words.js"
import {
	formatDefinitions,
	KbbiDictionary,
} from "../dist/modules/ai-moderation/kbbiDictionary.js"

const BASE = process.env.AI_DICTIONARY_BASE_URL ?? "http://100.121.180.82:4020"

// Real prod-shaped messages, including the slang that motivated the feature.
const TEXTS = [
	"dasar goblok otak kamu cok",
	"biji kopi nascentFilled",
	"cok kok kamu nih",
	"https://instagram.com/reel/abc123 sama @Rangga",
]

const perMessage = 8
const batch = selectBatchDictionaryWords(TEXTS, perMessage, 24)
console.log("selected words:", JSON.stringify(batch))

const kbbi = new KbbiDictionary({
	baseUrl: BASE,
	enabled: true,
	timeoutMs: 8000,
	maxWords: 24,
	maxWordsPerMessage: perMessage,
	maxCharsPerWord: 300,
	maxCharsPerBatch: 2000,
})

console.log("enabled:", kbbi.enabled, "| limits:", JSON.stringify(kbbi.limits))

const started = Date.now()
const entries = await kbbi.lookup(batch)
const ms = Date.now() - started

console.log(`lookup: ${entries.length}/${batch.length} defined in ${ms}ms`)
console.log("---")
console.log(formatDefinitions(entries))

// The properties that must hold against the LIVE service, not just a stub.
const problems: string[] = []
if (entries.length === 0) problems.push("live lookup returned nothing at all")
for (const e of entries) {
	if (!e.word) problems.push("entry with empty word")
	if (!e.definition.trim()) problems.push(`${e.word}: empty definition`)
	if (e.definition.length > 300)
		problems.push(
			`${e.word}: ${e.definition.length} chars exceeds per-word cap`,
		)
}
const totalChars = entries.reduce((n, e) => n + e.definition.length, 0)
if (totalChars > 2000) problems.push(`batch ${totalChars} chars exceeds cap`)

// A word the KBBI does not know must be ABSENT, not present-and-empty.
const bogus = await kbbi.lookup(["zzzqqqxyz"])
if (bogus.length !== 0)
	problems.push(`unknown word returned ${bogus.length} entries`)

// Ordering: requested order, not reply order.
if (batch.length > 1) {
	const order = entries.map((e) => e.word)
	const expected = batch.filter((w) => order.includes(w))
	if (JSON.stringify(order) !== JSON.stringify(expected))
		problems.push(
			`order drift: got ${order.join(",")} want ${expected.join(",")}`,
		)
}

if (problems.length > 0) {
	console.error("LIVE PROBE FAILED:")
	for (const p of problems) console.error("  -", p)
	process.exit(1)
}
console.log("LIVE PROBE OK")
