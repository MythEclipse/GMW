/**
 * Hindsight memory for the moderation model.
 *
 * ## What this adds to the prompt
 *
 * The moderation model judges each message from the message alone. That is
 * correct for the rules in `policy.ts` but blind to everything the guild has
 * already established: that user 411916947773587456 is Jockie Music and posts
 * embeds all day, that a channel trades crypto on Fridays, that "bocah" is
 * this guild's word for a beginner and not an insult. Hindsight holds that as
 * extracted facts, so the model receives it as a `<memory_context>` block
 * before the messages.
 *
 * ## The bank, and why it is not Hermes's
 *
 * Bank `gmw-moderation` on the Hindsight instance at 127.0.0.1:8890. That
 * instance also serves Hermes's own `hermes-gemini` bank (722+ facts about this
 * user).
 * The two are deliberately separate: moderation memory is written by a bot from
 * untrusted Discord content, and sharing a bank with an assistant's personal
 * memory would let a message author steer that memory, and let moderation
 * recall the user's own facts into a public moderation prompt.
 *
 * ## What gets stored, and what does not
 *
 * Every analysed message is retained (2026-09-30 decision: the full chronicle,
 * not only the flagged ones — the value is in the negative space, "this guild
 * treats X as routine"). Two consequences are deliberate:
 *
 * - Identity is stored in full, not as an id. A frozen `user_id` is useless to
 *   a semantic search six months later: the query is "who keeps posting jackpot
 *   links", and only a NAME is in that query. So each item carries the global
 *   username, the server-scoped nickname, the display name and the tag.
 * - Nothing raw that a moderator should not re-read is invented. The retain
 *   payload is the message text plus the verdict, never the Discord token or
 *   the attachment URL.
 *
 * ## What a memory is ABOUT: the conversation, not the behaviour
 *
 * Rebuilt 2026-10-01. The first version of this bank stored one message and
 * its verdict, and asked recall for "who habitually sends gambling links". The
 * result was 1402 documents in which every single fact was of the form
 * "<name> sent <text>, judged clean". A bank of that shape cannot answer the
 * question the moderation model is actually asking — "does this message belong
 * in this conversation" — because it holds no conversation. It answered
 * "is this person a spammer", which is a different question, asked about
 * people rather than about the text in front of the model.
 *
 * So each retained document now leads with WHERE the message was: the thread
 * name, the parent channel name, and the channel topic (see `describePlace`),
 * and is tagged with `thread:<id>` in addition to `channel:<id>` (see
 * `buildMemoryTags`). Recall asks about the discussion (see
 * `buildRecallQuery`). The verdict is still retained — it is what makes the
 * negative space usable — but it is the last fact in the document, not the
 * only one.
 *
 * All of this reads data that capture already had and threw away:
 * `channel.threadName`, `channel.channelName`, `channel.topic` and
 * `reference.messageId` were captured into `messages.metadata` since before
 * the memory bank existed, and nothing consumed them here until now.
 *
 * ## Tag filtering is a RANKING hint, not a wall
 *
 * Verified against the live instance on 2026-09-30, on bank `gmw-probe-t6`:
 * a recall filtered to `tags: ["channel:AAA"], tagsMatch: "any_strict"` still
 * returned an `observation` and a `world` fact whose own `tags` array was EMPTY
 * — untagged memories leak through a strict tag filter. The filter raises the
 * score of matching memories; it does not exclude the rest.
 *
 * So `recallChannelContext` filters AGAIN, client-side, on `result.tags`, and
 * drops anything that does not carry a tag we asked for. Tag filtering is a
 * performance and relevance optimisation. It is never the thing that makes
 * channel A's history invisible to channel B.
 *
 * ## Failure policy
 *
 * Hindsight is an enhancement, never a dependency. A timeout, a 404, an empty
 * bank — every path returns "" and the batch is judged on its own evidence
 * exactly as before. Nothing here can park a message, reset a lease, or make
 * the worker wait: recall happens inside the moderation call's own budget and
 * retain is fire-and-forget, so the lease arithmetic in `worker.ts` is
 * untouched.
 */

import { HindsightClient } from "@vectorize-io/hindsight-client"
import { config } from "../../config/index.js"
import { createChildLogger } from "../../logger/index.js"
import { escapeXmlAttr } from "../message-capture/messageMetadata.js"

const log = createChildLogger("ai-moderation/memory")

/**
 * One message's identity and evidence, as captured in `messages.metadata`.
 *
 * Every field is optional because the metadata column is nullable and older
 * rows predate some of these keys.
 */
export type MemoryAuthor = {
	/** Snowflake. Kept for exact match, not for search. */
	userId: string
	/** Discord's login name, unique account-wide — "budi_dev". */
	username: string | null
	/** The user's chosen display name — "Budi S." */
	globalName: string | null
	/** Per-guild display name, i.e. the nickname when one is set. */
	serverName: string | null
	bot: boolean
	/** Discord's legacy discriminator, when the account still has one. */
	tag: string | null
}

/**
 * Where a message sat in the conversation, as captured in `messages.metadata`.
 *
 * This is the whole point of the rebuild: the bank used to store one message
 * with its verdict and nothing else, so a recall could only ever answer "who
 * does what". Storing the thread, the reply target and the channel's topic
 * turns each memory into a piece of a conversation, so a recall can answer
 * "what is being discussed in this thread and has this come up before".
 *
 * Every field is optional because the metadata column is nullable and rows
 * captured before a key existed simply do not have it.
 */
export type MemoryContext = {
	/** The thread the message was posted in, when it was not the channel root. */
	threadId?: string | null
	/** Human-readable thread name — what people actually call the thread. */
	threadName?: string | null
	/** Parent channel name, so `#general` is a word in the bank, not just an id. */
	channelName?: string | null
	/** The channel topic. Says what the channel is FOR, which is the single
	 *  strongest signal for "does this message belong here". */
	topic?: string | null
	/** Discord channel type, so an announcement channel is distinguishable from
	 *  a support thread without resolving the id. */
	channelType?: string | null
	/** The message this replies to, when it is a reply. */
	referenceMessageId?: string | null
	/** The parent channel id when `threadId` is set. */
	referenceChannelId?: string | null
}

export type MemoryMessage = {
	messageId: string
	guildId: string
	channelId: string
	content: string
	createdAt: string
	author: MemoryAuthor
	/** The moderation model's own reading of the message, for the bank. */
	analysis: string
	status: string
	categories: string[]
	mediaDescription?: string
	/** Where the message sat in the conversation. Empty when nothing was captured. */
	context: MemoryContext
}

export type MemoryBankConfig = {
	baseUrl: string
	bankId: string
	/** Token budget for one recall. Small: this is prompt context, not a report. */
	recallMaxTokens: number
	/** Recall retrieval budget. `low` keeps latency near the measured 0.7s. */
	recallBudget: "low" | "mid" | "high"
	/** Per-call deadline for recall, counted against the moderation call. */
	recallTimeoutMs: number
	/** Hard cap on retained items per batch. */
	retainBatchSize: number
}

export const DEFAULT_MEMORY_BANK_CONFIG: MemoryBankConfig = {
	baseUrl: "http://127.0.0.1:8890",
	bankId: "gmw-moderation",
	recallMaxTokens: 1200,
	recallBudget: "low",
	recallTimeoutMs: 8_000,
	retainBatchSize: 40,
}

/**
 * Tags applied to every retained item, so recall can scope to a place.
 *
 * The thread tag is the rebuild's biggest practical win. Previously every
 * message in a channel carried the same two tags, so a recall scoped to
 * `#general` returned memories from every thread inside it and the model was
 * asked to judge a message in one discussion using evidence from unrelated
 * ones. Tagging the thread separately lets a recall be about the conversation
 * the model is actually looking at.
 *
 * `channel:` keeps the parent channel id, NOT the thread id: `claim_messages`
 * and the dashboard both talk in parent-channel terms, and a memory tagged with
 * the thread id would not match the channel the batch was claimed from. The
 * thread gets its own tag instead, so both scopes are available.
 */
export function buildMemoryTags(m: {
	guildId: string
	channelId: string
	context?: MemoryContext
}): string[] {
	const tags = [`channel:${m.channelId}`, `guild:${m.guildId}`]
	if (m.context?.threadId) tags.push(`thread:${m.context.threadId}`)
	return tags
}

/**
 * Flatten the captured metadata blob into the conversation context we store.
 *
 * The companion to `extractMemoryAuthor`, and split out for the same reason:
 * the mapping is unit-testable on its own, and a missing block yields an
 * empty object rather than an invented place. Inventing "thread:general" from
 * nothing would put a word in the bank that no channel was ever called, and a
 * recall would then keep matching that fiction.
 *
 * Only real, captured fields are read. `channel.topic` on a thread is already
 * resolved to the parent by `getMessageLocation`, so the value here is the
 * parent's topic — exactly what a moderator would read.
 */
export function extractMemoryContext(
	metadata: string | null | undefined,
): MemoryContext {
	const empty: MemoryContext = {}
	if (!metadata) return empty

	let parsed: unknown
	try {
		parsed = JSON.parse(metadata)
	} catch {
		return empty
	}
	if (typeof parsed !== "object" || parsed === null) return empty

	const root = parsed as {
		channel?: Record<string, unknown>
		reference?: Record<string, unknown> | null
	}
	const c = root.channel ?? {}
	const ref = root.reference ?? {}
	const str = (v: unknown): string | null =>
		typeof v === "string" && v.trim().length > 0 ? v.trim() : null

	const context: MemoryContext = {
		threadId: str(c.threadId),
		threadName: str(c.threadName),
		channelName: str(c.channelName),
		topic: str(c.topic),
		channelType: str(c.channelType),
		referenceMessageId: str(ref.messageId),
		referenceChannelId: str(ref.channelId),
	}

	// An all-null object is noise in the metadata and in the tests. Return the
	// empty shape so "nothing was captured" stays distinguishable from "a place
	// was captured but happened to have no name".
	return Object.values(context).some((v) => v !== null) ? context : empty
}

/**
 * The text handed to Hindsight for one message.
 *
 * Prose, not a field dump: the retain step runs an LLM extraction over this,
 * and a terse `user=123 msg=hello` yields a fact with no name in it — which is
 * exactly the useless "user 123 posted X" memory the identity work exists to
 * prevent. Names lead, and the verdict rides along so a later recall can ask
 * "has this guild seen this scam before" without a second lookup.
 *
 * The conversation context leads right after the author, because that is what
 * makes the memory answer a question about the conversation rather than about a
 * person: "in thread 'diskusi-app' under #general, whose topic is daily server
 * chatter" is the framing that lets a recall return the discussion instead of
 * a behaviour log.
 */
export function formatMemoryContent(m: MemoryMessage): string {
	const names = [
		m.author.globalName,
		m.author.serverName,
		m.author.username,
	].filter((n): n is string => Boolean(n?.trim()))
	const named = names.length > 0 ? names.join(" / ") : m.author.userId

	const parts: string[] = [
		m.author.bot
			? `Bot ${named} mengirim pesan ${describePlace(m.context)}.`
			: `Anggota ${named} mengirim pesan ${describePlace(m.context)}.`,
	]

	const body = m.content.trim()
	parts.push(
		body.length > 0
			? `Isi pesan: "${body}"`
			: "Pesan tanpa teks (hanya lampiran atau embed).",
	)

	if (m.mediaDescription?.trim()) {
		parts.push(`Deskripsi media: ${m.mediaDescription.trim()}`)
	}

	parts.push(
		`Penilaian moderasi: status=${m.status}` +
			(m.categories.length > 0 ? `, kategori=${m.categories.join(", ")}` : ""),
	)
	if (m.analysis.trim()) parts.push(`Analisis moderator: ${m.analysis.trim()}`)

	return parts.join(" ")
}

/**
 * Render a message's place in the conversation as one phrase.
 *
 * Names over ids, always. A recall query is words, and "apa yang dibicarakan
 * di #general" has to be able to match a memory saying `thread "diskusi-app"
 * di #general` — an id never matches either. Ids stay in the tags and metadata,
 * where exact matching happens, and out of the prose, where they are noise.
 *
 * Starts with the connective rather than a noun so it slots into the sentence
 * above in every combination: "di thread \"x\" pada #y" and "di #y" are both
 * grammatical after "mengirim pesan".
 */
function describePlace(ctx: MemoryContext): string {
	const channel = ctx.channelName ? `#${ctx.channelName}` : null
	const thread = ctx.threadName ? `thread "${ctx.threadName}"` : null

	let place: string
	if (thread && channel) place = `di ${thread} pada ${channel}`
	else if (thread) place = `di ${thread}`
	else if (channel) place = `di ${channel}`
	else place = "di channel tanpa nama"

	const topic = ctx.topic ? ` (topik channel: "${ctx.topic}")` : ""
	return `${place}${topic}`
}

/**
 * The distinct places a batch covers, for the `<memory_context>` attribute.
 *
 * Thread names win over channel names when both exist, because the thread is
 * the narrower and more informative scope and a batch of one thread should not
 * be labelled with its parent. Falls back to the channel when no thread name
 * was captured, and finally to a count-free placeholder so the attribute never
 * renders empty.
 *
 * `describePlace` is the per-message prose and `describePlaces` is this batch
 * label; they are separate because one message can sit in a thread whose name
 * was never captured while the batch as a whole is in a named channel.
 */
function describePlaces(messages: readonly MemoryMessage[]): string[] {
	const threads = [
		...new Set(
			messages
				.map((m) => m.context.threadName)
				.filter((n): n is string => Boolean(n?.trim())),
		),
	]
	if (threads.length > 0) return threads.slice(0, 4)

	const channels = [
		...new Set(
			messages
				.map((m) => m.context.channelName)
				.filter((n): n is string => Boolean(n?.trim())),
		),
	]
	if (channels.length > 0) return channels.slice(0, 4).map((c) => `#${c}`)

	return ["tanpa nama"]
}

/**
 * Flatten the captured metadata blob into the identity we store.
 *
 * Kept separate from `formatMemoryContent` so the identity mapping is unit
 * testable without asserting on prose. A missing block yields nulls rather than
 * an invented name — a memory claiming someone is "Budi" when the capture had
 * only an id is worse than a memory that admits it knows the id.
 */
export function extractMemoryAuthor(
	authorId: string,
	metadata: string | null | undefined,
): MemoryAuthor {
	const empty: MemoryAuthor = {
		userId: authorId,
		username: null,
		globalName: null,
		serverName: null,
		bot: false,
		tag: null,
	}
	if (!metadata) return empty

	let parsed: unknown
	try {
		parsed = JSON.parse(metadata)
	} catch {
		return empty
	}
	if (typeof parsed !== "object" || parsed === null) return empty

	const root = parsed as {
		author?: Record<string, unknown>
		member?: Record<string, unknown> | null
	}
	const a = root.author ?? {}
	const m = root.member ?? {}
	const str = (v: unknown): string | null =>
		typeof v === "string" && v.trim().length > 0 ? v.trim() : null

	// `member.displayName` IS the nickname on a guild message, so it is the
	// server-scoped name. `author.globalName` is the account-wide display name,
	// which is what this library populates on the author object.
	return {
		userId: authorId,
		username: str(a.username),
		globalName: str(a.globalName),
		serverName: str(m.nickname) ?? str(m.displayName),
		bot: a.bot === true,
		tag: str(a.tag),
	}
}

/** The wire shape of one result row, narrowed to what we consume. */
type RecallRow = {
	text?: string | null
	type?: string | null
	tags?: string[] | null
}

export type ModerationMemory = {
	text: string
	type: string
}

/**
 * Thin wrapper over the Hindsight client.
 *
 * Deliberately not a singleton created at import time: config validation is a
 * side effect of importing `@/shared/config`, and tests inject a stub. The
 * worker receives this like the LLM gateway, so nothing here needs a network.
 */
export class ModerationMemoryBank {
	private client: HindsightClient | null = null

	constructor(
		private readonly cfg: MemoryBankConfig = DEFAULT_MEMORY_BANK_CONFIG,
	) {}

	/**
	 * The Hindsight client, built once and kept.
	 *
	 * Recycling it was tried and is deliberately NOT done here. Measured
	 * production data drove that: one worker process logged 296 of 309 recalls
	 * timing out at the 8s deadline between 08:17 and 16:58, and a plain restart
	 * made the identical code succeed 295 times with 1 timeout — same bank, same
	 * deadline, same payload. That looks like per-process state, so throwing the
	 * client away every couple of minutes looked like the fix.
	 *
	 * It is not, and shipping it would have been a fix with a story attached. The
	 * SDK holds nothing but a config object: it delegates to `globalThis.fetch`
	 * and owns no pool, no sockets and no dispatcher, so a fresh client reuses the
	 * very same shared connection pool the stale one was using. Rebuilding it
	 * cannot drop a socket that the client never held. The per-process cause of
	 * the 08:17–16:58 run is therefore still unidentified, and the honest state of
	 * it is recorded above rather than papered over with a change that cannot
	 * work.
	 *
	 * What is kept is the deadline itself, which does bound the damage: see
	 * `withTimeout`.
	 */
	private getClient(): HindsightClient {
		if (!this.client) {
			this.client = new HindsightClient({
				baseUrl: this.cfg.baseUrl,
				userAgent: "gmw-moderation-worker/1.0",
				// Recall is idempotent, so the SDK's capacity retry is worth having.
				// Writes are never retried by the SDK, which is correct for a memory
				// write we must not duplicate.
				maxAttempts: 2,
			})
		}
		return this.client
	}

	/**
	 * Fetch what this channel's history already knows.
	 *
	 * Returns "" on every failure path, including "nothing relevant". The caller
	 * interpolates the result straight into the prompt, so an empty string must
	 * mean "say nothing", never "say something went wrong".
	 */
	async recallChannelContext(messages: MemoryMessage[]): Promise<string> {
		if (messages.length === 0) return ""

		// One query per batch, scoped to the places in it. A batch spans channels
		// (claim_messages does not group), so the tags are the union — and the
		// client-side filter below is what actually keeps them apart.
		//
		// `channel:` alone is the scope; `thread:` is ADDED to it as a ranking hint
		// rather than a second scope. Filtering on the union client-side is
		// deliberate: a message posted in the channel root carries no `thread:` tag
		// at all, so demanding a thread tag would silently drop every root message
		// in the channel from its own channel's context.
		const channels = [...new Set(messages.map((m) => m.channelId))]
		const threadIds = [
			...new Set(
				messages
					.map((m) => m.context.threadId)
					.filter((t): t is string => Boolean(t?.trim())),
			),
		]
		const tags = [
			...channels.map((c) => `channel:${c}`),
			...threadIds.map((t) => `thread:${t}`),
		]

		try {
			const client = this.getClient()
			const response = await withTimeout(
				(signal) =>
					client.recall(this.cfg.bankId, buildRecallQuery(messages), {
						budget: this.cfg.recallBudget,
						maxTokens: this.cfg.recallMaxTokens,
						tags,
						tagsMatch: "any_strict",
						// Without this, recall returns both the consolidated observation and
						// the raw facts it was built from, and the prompt carries the same
						// sentence twice.
						preferObservations: true,
						// Carries the deadline all the way down: on timeout the request is
						// cancelled, not just abandoned.
						signal,
					}),
				this.cfg.recallTimeoutMs,
			)

			const kept = filterByTags(response.results, tags)
			if (kept.length === 0) return ""

			// Name the places in the attribute, not the ids: the block is read by the
			// model, and "#general" tells it which conversation this is while
			// "1122334455667788" tells it nothing.
			return formatMemoryContext(kept, describePlaces(messages))
		} catch (e) {
			log.warn(
				{
					err: e instanceof Error ? e.message : String(e),
					channels: channels.length,
					threads: threadIds.length,
					messages: messages.length,
				},
				"hindsight recall failed — analysing without memory context",
			)
			return ""
		}
	}

	/**
	 * Store a batch of judged messages. Fire-and-forget by design.
	 *
	 * The worker calls this WITHOUT awaiting, so the cost (measured 3.3s for a
	 * 2-item sync retain, and that is an LLM extraction) never lands on the
	 * claim. Retention therefore lags analysis by however long Hindsight's queue
	 * takes, which is the accepted trade for leaving the lease arithmetic
	 * untouched.
	 */
	retainBatch(messages: MemoryMessage[]): void {
		if (messages.length === 0) return

		const items = messages.slice(0, this.cfg.retainBatchSize).map((m) => ({
			content: formatMemoryContent(m),
			timestamp: m.createdAt,
			context: "discord-moderation-verdict",
			// Per-message document_id makes a retried write idempotent: retaining
			// the same message twice updates the same document instead of creating
			// a near-duplicate memory.
			document_id: `msg-${m.messageId}`,
			metadata: {
				message_id: m.messageId,
				guild_id: m.guildId,
				channel_id: m.channelId,
				user_id: m.author.userId,
				username: m.author.username ?? "",
				global_name: m.author.globalName ?? "",
				server_name: m.author.serverName ?? "",
				// The conversation placement, kept as metadata as well as prose. Prose
				// is what recall can match semantically; metadata is what a future
				// scoped query can filter on exactly without re-parsing Indonesian
				// sentences. Both, because they answer different questions.
				thread_id: m.context.threadId ?? "",
				thread_name: m.context.threadName ?? "",
				channel_name: m.context.channelName ?? "",
				channel_topic: m.context.topic ?? "",
				reference_message_id: m.context.referenceMessageId ?? "",
				status: m.status,
				categories: m.categories.join(","),
			},
			tags: buildMemoryTags(m),
		}))

		const client = this.getClient()
		// Deliberately not awaited: this runs inside the worker's lease, and the
		// promise can take seconds. The catch keeps an unhandled rejection from
		// taking down the worker process.
		void client
			.retainBatch(this.cfg.bankId, items, { async: true })
			.catch((e: unknown) => {
				log.warn(
					{
						err: e instanceof Error ? e.message : String(e),
						bank: this.cfg.bankId,
						items: items.length,
					},
					"hindsight retain failed — memory will lag, moderation is unaffected",
				)
			})
	}

	/** Config from env, with Hindsight off unless explicitly enabled. */
	static fromConfig(): ModerationMemoryBank {
		return new ModerationMemoryBank({
			baseUrl: config.AI_MEMORY_BASE_URL,
			bankId: config.AI_MEMORY_BANK_ID,
			recallMaxTokens: config.AI_MEMORY_RECALL_MAX_TOKENS,
			recallBudget: config.AI_MEMORY_RECALL_BUDGET,
			recallTimeoutMs: config.AI_MEMORY_RECALL_TIMEOUT_MS,
			retainBatchSize: config.AI_MEMORY_RETAIN_BATCH_SIZE,
		})
	}
}

/**
 * Drop rows whose own tags do not include one we asked for.
 *
 * Exists because the server leaks untagged rows through a strict filter
 * (verified 2026-09-30, see the module docblock). `any_strict` removes untagged
 * rows on a clean bank, but not once consolidation has produced an observation
 * without tags, so this second gate is what actually holds.
 */
export function filterByTags(
	results: readonly RecallRow[],
	want: readonly string[],
): RecallRow[] {
	const wanted = new Set(want)
	return results.filter((r) => (r.tags ?? []).some((t) => wanted.has(t)))
}

/**
 * Build the query text from what is actually in the batch.
 *
 * The old query was `Riwayat moderasi channel <ids> — peserta <names> — norma
 * kanal, siapa yang habitually mengirim link judi atau promosi, dan topik apa
 * yang biasa dibahas`. Three of its four clauses ask about PEOPLE, which is why
 * the bank filled with behaviour logs and every recall came back as "who does
 * what". The model is not asking "who is this person"; it is asking "does this
 * message belong in this conversation" — so the query has to be about the
 * conversation.
 *
 * What goes in, in priority order:
 *
 * 1. Place, by NAME — thread name and channel name, because those are the
 *    words a memory was stored with (`describePlace` writes them into the
 *    prose) and the only terms that can match it back.
 * 2. The topic, which is the channel's stated purpose.
 * 3. Participant names, still useful for "has this person said anything about
 *    this here before", but capped and last so they never dominate the query.
 *
 * Deliberately NOT channel/thread ids: an id is noise in a semantic query and
 * cannot match prose that stores names. Ids still scope the search through
 * `tags`, which is what `any_strict` and `filterByTags` are for.
 */
export function buildRecallQuery(messages: MemoryMessage[]): string {
	const threads = [
		...new Set(
			messages
				.map((m) => m.context.threadName)
				.filter((n): n is string => Boolean(n?.trim())),
		),
	].slice(0, 3)
	const channels = [
		...new Set(
			messages
				.map((m) => m.context.channelName)
				.filter((n): n is string => Boolean(n?.trim())),
		),
	].slice(0, 3)
	const topics = [
		...new Set(
			messages
				.map((m) => m.context.topic)
				.filter((n): n is string => Boolean(n?.trim())),
		),
	].slice(0, 2)
	const authors = [
		...new Set(
			messages
				.flatMap((m) => [
					m.author.globalName,
					m.author.serverName,
					m.author.username,
				])
				.filter((n): n is string => Boolean(n?.trim())),
		),
	].slice(0, 4)

	const parts: string[] = []

	// The place leads, because it is the strongest filter and the least noisy.
	if (threads.length > 0) {
		parts.push(
			`Apa yang sedang dan pernah dibahas di thread ${threads
				.map((t) => `"${t}"`)
				.join(", ")}`,
		)
	}
	if (channels.length > 0) {
		parts.push(
			threads.length > 0
				? `pada channel ${channels.map((c) => `#${c}`).join(", ")}`
				: `Apa yang pernah dibahas di channel ${channels
						.map((c) => `#${c}`)
						.join(", ")}`,
		)
	}
	if (topics.length > 0) {
		parts.push(`topik channel: ${topics.map((t) => `"${t}"`).join("; ")}`)
	}

	// A batch whose metadata was never captured has no place to ask about. Naming
	// the participants instead is the one thing it must NOT do: that produced the
	// "who is this person" query that turned the bank into a behaviour log, and a
	// place-less batch is exactly the case where that failure is most tempting.
	const hasPlace =
		threads.length > 0 || channels.length > 0 || topics.length > 0

	if (authors.length > 0 && hasPlace) {
		// Participant names, not "people who behave a certain way". They sit last
		// so they can only ever disambiguate a place that is already named.
		parts.push(`peserta: ${authors.join(", ")}`)
	}

	// The tail states the question in the shape the answer should take. It keeps
	// "what is being discussed" and "what does this guild treat as normal" —
	// the negative space, which is why the full chronicle is retained — and drops
	// the "who habitually sends gambling links" clause that made this a
	// behaviour query.
	if (!hasPlace) {
		parts.push("Riwayat pesan dan penilaian moderasi di kanal ini")
	}
	parts.push(
		"termasuk topik, istilah, dan hal yang sudah pernah dibahas atau diperdebatkan di sini",
	)

	return parts.join(" — ")
}

/**
 * Render an author for the `<message author="…">` attribute.
 *
 * Carries every name the bank knows, because that is the join key. A recall
 * says "Zulfikar posted a jackpot link"; the message in front of the model
 * says `zulfik_dev (1234)`. Neither string contains the other, so the model
 * cannot tell they are the same person and the memory is wasted. All three
 * names in one attribute makes that connection obvious.
 *
 * Escaped for an XML attribute — display names are user-controlled.
 */
export function formatAuthorForPrompt(author: MemoryAuthor): string {
	const parts = [author.username, author.globalName, author.serverName].filter(
		(n): n is string => Boolean(n?.trim()),
	)
	// The snowflake always closes it, so an id-only author is still
	// distinguishable and never renders as an empty attribute.
	parts.push(author.userId)
	return escapeXmlAttr([...new Set(parts)].join(" | "))
}

/** Render recall rows as the `<memory_context>` block. */
export function formatMemoryContext(
	rows: readonly RecallRow[],
	channels: readonly string[],
): string {
	const body = rows
		.map((r) => {
			const text = (r.text ?? "").trim()
			return text ? `- (${r.type ?? "fact"}) ${text}` : ""
		})
		.filter(Boolean)
		.join("\n")
	if (!body) return ""

	return `<memory_context bank="gmw-moderation" channels="${escapeXmlAttr(
		channels.join(","),
	)}">\n${body}\n</memory_context>`
}

/**
 * Run a Hindsight call under a deadline, and CANCEL IT if the deadline hits.
 *
 * Racing a timer alone only stops the caller waiting. The request itself keeps
 * running, which is how 309 of 367 production recalls ended as "timed out"
 * while the server was still chewing on them — the worker had moved on, and
 * the responses arrived into nothing. An `AbortController` fixes the leak, and
 * the client honours `signal` at every hop including its own capacity retry
 * backoff, so an abort during a 429 wait is not delayed by that wait.
 *
 * The timer is cleared either way, so an early success does not leave a pending
 * handle keeping the process alive.
 */
async function withTimeout<T>(
	send: (signal: AbortSignal) => Promise<T>,
	ms: number,
): Promise<T> {
	// A non-positive deadline means "no deadline": pass through untouched rather
	// than abort instantly.
	if (!(ms > 0)) return send(new AbortController().signal)

	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			send(controller.signal),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort(new Error(`hindsight recall exceeded ${ms}ms`))
					reject(new Error(`hindsight recall exceeded ${ms}ms`))
				}, ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
