/**
 * KBBI lookup for the moderation model.
 *
 * ## What this adds to the prompt
 *
 * The moderation model reads Indonesian slang with no dictionary. "kontol" as
 * banter between friends and "kontol" as a sexual reference are the same bare
 * word to it, so it picks a meaning and then judges the message from the
 * meaning it invented. That is not hypothetical: production analysis came back
 * with invented slang roots, and a phrase judged "clean" turned out to contain
 * a sexual term the model had guessed wrong.
 *
 * The KBBI is the authority on what a word means in Indonesian, so the model
 * gets the official senses instead of its own recollection. `formatDefinitions`
 * renders them as a `<dictionary>` block inside the message that used the word.
 *
 * ## Keyed by the echoed word, never by array position
 *
 * `GET /api/words?words=a&words=b&words=c` returns `results` with one row per
 * requested word, including `status: "not_found"` for a word with no entry. Each
 * row echoes the word it answered for in `results[i].word`, verified against the
 * live service.
 *
 * Position and echo agree today, but position is the assumption that fails
 * silently: if the service ever dropped a row instead of returning `not_found`,
 * index 1 becomes index 0 and "makan" gets handed the definition for "biji" — a
 * fluent, plausible, entirely wrong definition reaching the moderator. Keying by
 * the echoed word makes that impossible, and a word the service did not answer
 * for simply produces no line.
 *
 * ## Every failure path degrades to nothing
 *
 * Grounding is an enhancement. A dictionary that is down, slow or returning
 * garbage must cost the prompt its `<dictionary>` block and nothing else — the
 * batch is still judged on its own evidence, exactly as before this existed.
 * `lookup` never throws and never retries.
 */

import { config } from "../../config/index.js"
import { createChildLogger } from "../../logger/index.js"
import { escapeXmlAttr } from "../message-capture/messageMetadata.js"

const log = createChildLogger("ai-moderation/kbbi")

/** One rendered word: its official senses, and whether KBBI calls it standard. */
export type DictionaryEntry = {
	/** The word, lowercased, as it was requested. */
	word: string
	/** Official senses joined by "; ", already length-capped. */
	definition: string
	/**
	 * False when the KBBI holds the word only as a non-standard form.
	 *
	 * Worth surfacing: it says the model is reading a colloquialism, so it should
	 * weigh the surrounding context rather than the dictionary sense alone.
	 */
	standard: boolean
}

export type DictionaryConfig = {
	baseUrl: string
	timeoutMs: number
	/** Words per request. The API repeats `words=`, so this bounds URL length. */
	maxWords: number
	/**
	 * Words taken from ONE message.
	 *
	 * Public because the worker needs it, and it must not read the limit from a
	 * second place: a selection budget owned by the adapter and a different one
	 * owned by the caller is a pair that drifts, and the symptom is a prompt that
	 * quietly stops carrying definitions for the messages that needed them most.
	 */
	maxWordsPerMessage: number
	/** Rendered characters per word. */
	maxCharsPerWord: number
	/** Rendered characters for the whole batch — the real ceiling on growth. */
	maxCharsPerBatch: number
}

export const DEFAULT_DICTIONARY_CONFIG: DictionaryConfig = {
	baseUrl: "http://100.121.180.82:4020",
	timeoutMs: 4_000,
	maxWords: 24,
	maxWordsPerMessage: 8,
	maxCharsPerWord: 300,
	maxCharsPerBatch: 2_000,
}

/** Joins the senses of one word. Named so the cap can account for its width. */
const SEPARATOR = "; "

/** The service's wire shape, narrowed to what we read. Defensive on purpose. */
type ApiMakna = { submakna?: unknown }
type ApiEntri = { makna?: unknown }
type ApiResult = {
	word?: unknown
	status?: unknown
	entry?: { data?: { entri?: unknown } } | null
	standard?: { is_standard?: unknown } | null
}

/** Pull the sense strings out of one homonym entry. */
function sensesOf(entri: ApiEntri): string[] {
	if (!Array.isArray(entri.makna)) return []
	const out: string[] = []
	for (const m of entri.makna as ApiMakna[]) {
		if (!Array.isArray(m?.submakna)) continue
		for (const s of m.submakna) {
			if (typeof s === "string" && s.trim().length > 0) out.push(s.trim())
		}
	}
	return out
}

/**
 * Render one word's official senses, capped.
 *
 * A KBBI entry runs to thousands of characters across every homonym — "biji"
 * has two, "makan" has several senses under each. The early senses carry the
 * common meaning, so the tail is DROPPED rather than truncated mid-sentence: a
 * definition cut in half is worse than none, because it still reads as
 * authoritative.
 */
function renderDefinition(
	entri: readonly ApiEntri[],
	maxChars: number,
): string {
	const lines: string[] = []
	// Counts the separator too, not just the sense text. Joining with "; " adds
	// two characters between senses, so counting senses alone lets the rendered
	// string overshoot the cap by 2 * (senses - 1) — measured at 303 chars
	// against a 300 cap on the live service for "kopi". A cap that is routinely
	// exceeded by a few percent is not a cap.
	let used = 0
	for (const e of entri) {
		for (const sense of sensesOf(e)) {
			const cost = sense.length + (lines.length > 0 ? SEPARATOR.length : 0)
			if (used + cost > maxChars) return lines.join(SEPARATOR)
			lines.push(sense)
			used += cost
		}
	}
	return lines.join(SEPARATOR)
}

/**
 * Flatten one API row into a `DictionaryEntry`, or null when there is nothing
 * usable — `not_found`, no `data`, or senses that are all empty.
 *
 * The caller drops nulls, so a word the dictionary does not know contributes no
 * line at all rather than an empty one. An empty `<definition>` would read to
 * the model as "this word has no meaning", which is a claim the lookup never
 * made.
 */
function toEntry(row: ApiResult, maxChars: number): DictionaryEntry | null {
	if (row.status !== "success") return null
	const entri = row.entry?.data?.entri
	if (!Array.isArray(entri) || entri.length === 0) return null

	const definition = renderDefinition(entri as ApiEntri[], maxChars)
	if (definition.length === 0) return null

	return {
		word: typeof row.word === "string" ? row.word : "",
		definition,
		// An absent `standard` means the service did not classify it. Treating that
		// as standard stops an older payload from making every word look like a
		// colloquialism.
		standard: row.standard?.is_standard !== false,
	}
}

/**
 * Thin HTTP client for the KBBI service.
 *
 * Not a singleton created at import time: config validation is a side effect of
 * importing `@/shared/config`, and tests inject a fetch stub. The worker
 * receives this like the LLM gateway, so nothing here needs a live service.
 */
export class KbbiDictionary {
	/**
	 * Whether the last `lookup` actually reached the service and read a reply.
	 *
	 * Read immediately after `lookup`. False means "we do not know", which is not
	 * the same as "the dictionary has no such word" — see `lookup`.
	 */
	consulted = false
	private readonly cache = new Map<string, DictionaryEntry | null>()
	private readonly maxCacheSize = 5000

	constructor(
		private readonly cfg: DictionaryConfig = DEFAULT_DICTIONARY_CONFIG,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	/**
	 * The selection budgets, for the caller that picks the words.
	 *
	 * A getter over the private config rather than a public field: the adapter
	 * owns these numbers (they are in its env schema), and exposing them as
	 * mutable public state would let a caller and the adapter disagree — the
	 * selection budget would then be read from one place and the request budget
	 * from another, and the symptom is a prompt that quietly stops carrying
	 * definitions.
	 */
	get limits(): {
		maxWords: number
		maxWordsPerMessage: number
		maxCharsPerBatch: number
	} {
		return {
			maxWords: this.cfg.maxWords,
			maxWordsPerMessage: this.cfg.maxWordsPerMessage,
			maxCharsPerBatch: this.cfg.maxCharsPerBatch,
		}
	}

	/** Clear the word definition cache (used by tests or hot reloads). */
	clearCache(): void {
		this.cache.clear()
		this.phraseCache = null
	}

	private phraseCache: ReadonlySet<string> | null = null

	/**
	 * Every phrase headword the service knows, fetched once and cached.
	 *
	 * The selection layer needs the full set to match multi-word spans in a
	 * message — asking the service per candidate span would be one request per
	 * token window, which is the exact latency blow-up the batch lookup was
	 * built to avoid. The list is built from `/api/phrases`; a service without
	 * that route names no phrases and phrase-first selection silently degrades
	 * to the old whole-word-only behaviour.
	 *
	 * Returns an empty set on any failure — grounding is an enhancement, never
	 * a blocker — and `consulted` is NOT set: a phrase-list failure must not
	 * tell the worker the service had anything to say about words either.
	 */
	async phrases(): Promise<ReadonlySet<string>> {
		if (this.phraseCache) return this.phraseCache
		const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/api/phrases`
		try {
			const response = await this.fetchImpl(url, {
				signal: AbortSignal.timeout(this.cfg.timeoutMs),
				headers: { accept: "application/json" },
			})
			if (!response.ok) {
				log.warn(
					{ status: response.status },
					"kbbi phrase list unavailable — phrase-first selection off",
				)
				return new Set()
			}
			const payload = (await response.json()) as { phrases?: unknown }
			const list = Array.isArray(payload.phrases)
				? payload.phrases.filter((p): p is string => typeof p === "string")
				: []
			const set = new Set(list)
			this.phraseCache = set
			return set
		} catch (e) {
			log.warn(
				{ err: e instanceof Error ? e.message : String(e) },
				"kbbi phrase list fetch failed — phrase-first selection off",
			)
			return new Set()
		}
	}

	private cacheSet(word: string, entry: DictionaryEntry | null): void {
		if (this.cache.size >= this.maxCacheSize) {
			const oldestKey = this.cache.keys().next().value
			if (oldestKey !== undefined) this.cache.delete(oldestKey)
		}
		this.cache.set(word, entry)
	}

	/**
	 * Look up words, returning only those the dictionary actually defines.
	 *
	 * Returns `[]` on every failure path and on an empty request. Never throws:
	 * the caller interpolates the result straight into a prompt, so an empty array
	 * must mean "say nothing", never "say something went wrong".
	 *
	 * `[]` is AMBIGUOUS on its own — "the service is down" and "the service says
	 * it has none of these words" are the same array. The caller needs the
	 * difference: only a real reply may render `<not_in_dictionary>`, because a
	 * timeout must not tell the model the KBBI denied words it was never asked
	 * about. `consulted` carries that.
	 */
	async lookup(words: readonly string[]): Promise<DictionaryEntry[]> {
		if (words.length === 0) {
			this.consulted = false
			return []
		}

		const batch = [...new Set(words)]
			.filter((w) => w.trim().length > 0)
			.slice(0, this.cfg.maxWords)
		if (batch.length === 0) {
			this.consulted = false
			return []
		}

		// Check in-memory cache first to avoid repeating network requests for common words
		const uncachedWords: string[] = []
		const resolvedByWord = new Map<string, DictionaryEntry>()

		for (const word of batch) {
			if (this.cache.has(word)) {
				const cached = this.cache.get(word)
				if (cached) {
					resolvedByWord.set(word, cached)
				}
			} else {
				uncachedWords.push(word)
			}
		}

		// If every requested word is already resolved in cache, return immediately
		if (uncachedWords.length === 0) {
			this.consulted = true
			const ordered: DictionaryEntry[] = []
			let used = 0
			for (const word of batch) {
				const entry = resolvedByWord.get(word)
				if (!entry) continue
				if (used + entry.definition.length > this.cfg.maxCharsPerBatch) break
				ordered.push(entry)
				used += entry.definition.length
			}
			return ordered
		}

		const url =
			`${this.cfg.baseUrl.replace(/\/+$/, "")}/api/words` +
			`?${uncachedWords.map((w) => `words=${encodeURIComponent(w)}`).join("&")}`

		try {
			const response = await this.fetchImpl(url, {
				signal: AbortSignal.timeout(this.cfg.timeoutMs),
				headers: { accept: "application/json" },
			})
			if (!response.ok) {
				log.warn(
					{ status: response.status, words: uncachedWords.length },
					"kbbi lookup returned non-OK — analysing without definitions",
				)
				this.consulted = false
				return []
			}

			const payload = (await response.json()) as { results?: unknown }
			if (!Array.isArray(payload.results)) {
				this.consulted = false
				return []
			}

			// A well-formed reply: the service was asked and answered. Only now may
			// a word missing from `byWord` be reported as genuinely unknown — before
			// this point an empty result means "we never found out".
			this.consulted = true

			const fetchedByWord = new Map<string, DictionaryEntry>()
			for (const raw of payload.results as ApiResult[]) {
				const entry = toEntry(raw, this.cfg.maxCharsPerWord)
				if (entry && entry.word) {
					fetchedByWord.set(entry.word, entry)
					this.cacheSet(entry.word, entry)
				}
			}

			// Record words that were queried and confirmed not in dictionary as null
			for (const word of uncachedWords) {
				if (!fetchedByWord.has(word)) {
					this.cacheSet(word, null)
				}
			}

			// Re-emit in REQUESTED order so the block reads in the order the words
			// appear, and stop at the batch cap as we go — building every definition
			// and trimming afterwards would pay for the ones we discard.
			const ordered: DictionaryEntry[] = []
			let used = 0
			for (const word of batch) {
				const entry = resolvedByWord.get(word) ?? fetchedByWord.get(word)
				if (!entry) continue
				if (used + entry.definition.length > this.cfg.maxCharsPerBatch) break
				ordered.push(entry)
				used += entry.definition.length
			}
			return ordered
		} catch (e) {
			log.warn(
				{
					err: e instanceof Error ? e.message : String(e),
					words: uncachedWords.length,
				},
				"kbbi lookup failed — analysing without definitions",
			)
			this.consulted = false
			return []
		}
	}

	/** Config from env, with the dictionary off unless explicitly enabled. */
	static fromConfig(): KbbiDictionary {
		return new KbbiDictionary({
			baseUrl: config.AI_DICTIONARY_BASE_URL,
			timeoutMs: config.AI_DICTIONARY_TIMEOUT_MS,
			maxWords: config.AI_DICTIONARY_MAX_WORDS,
			maxWordsPerMessage: config.AI_DICTIONARY_MAX_WORDS_PER_MESSAGE,
			maxCharsPerWord: config.AI_DICTIONARY_MAX_CHARS_PER_WORD,
			maxCharsPerBatch: config.AI_DICTIONARY_MAX_CHARS_PER_BATCH,
		})
	}
}

/**
 * Render entries as the `<dictionary>` block.
 *
 * Placed INSIDE the `<message>` element that used the words, not beside it: a
 * definition only has meaning relative to the message it grounds, and a
 * sibling block reads to the model as one shared bag of definitions for the
 * whole batch — which is how "biji" (seed) ends up explaining a message about
 * something else entirely.
 *
 * `standard="false"` is what stops the model reading a colloquialism as its
 * dictionary form: the KBBI lists "bokap" as non-standard, and the model needs
 * to know the official sense is not what the speaker meant.
 */
export function formatDefinitions(
	entries: readonly DictionaryEntry[],
	unknownWords: readonly string[] = [],
): string {
	if (entries.length === 0 && unknownWords.length === 0) return ""

	const lines = entries.map(
		(e) =>
			`  <definition word="${escapeXmlAttr(e.word)}" standard="${e.standard}">` +
			`${e.definition}</definition>`,
	)

	// Words we ASKED about and the dictionary does not have. Rendering them as an
	// explicit absence is what stops the model filling the gap from its own
	// memory: prod had "Cumyami" come back not_found, the row was dropped, and
	// the verdict then asserted the word "berarti 'cuma yang'" — an invented
	// definition, presented to a moderator as analysis. A named hole reads as a
	// hole; a silent one reads as an oversight to be filled in.
	if (unknownWords.length > 0) {
		lines.push(
			`  <not_in_dictionary words="${escapeXmlAttr(unknownWords.join(" "))}" />`,
		)
	}

	return `\n<dictionary>\n${lines.join("\n")}\n</dictionary>`
}
