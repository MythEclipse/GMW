/**
 * Unified configuration schema shared by all services.
 *
 * This is the single source of truth for all environment variables.
 * Individual services re-export from here; they do NOT define their own schemas.
 */

import { z } from "zod"
import { ConfigError } from "../errors/index.js"

export const configSchema = z
	.object({
		// ── Discord ──────────────────────────────────────────────────────────
		DISCORD_TOKEN: z
			.string()
			.min(1, "DISCORD_TOKEN is required")
			.transform((value) => value.replace(/^("|')|(?:("|'))$/g, "")),
		MONITOR_GUILD_IDS: z
			.string()
			.default("")
			.transform((v) => v.split(",").filter(Boolean)),
		MONITOR_GUILD_ID: z.string().min(1).optional(),
		TEXT_GUILD_ID: z.string().min(1).optional(),
		TEXT_CHANNEL_ID: z.string().min(1).optional(),
		EXCLUDED_CHANNEL_IDS: z
			.string()
			.default("")
			.transform((v) => v.split(",").filter(Boolean))
			.describe("Channel IDs to exclude from capture"),
		EXCLUDED_THREAD_IDS: z
			.string()
			.default("")
			.transform((v) => v.split(",").filter(Boolean))
			.describe("Thread IDs to exclude from capture"),
		BOT_EXCLUDED_CHANNEL_IDS: z
			.string()
			.default("1206269771340058694,1318544753821880362")
			.transform((v) => v.split(",").filter(Boolean))
			.describe(
				"Channel IDs where bot messages are NOT captured/analyzed (bot detection stays on everywhere else)",
			),
		// User IDs whose messages are captured but NEVER AI-analyzed (skip result
		// directly, like age-restricted). Used for high-volume music/reaction
		// bots that spam the chat log (e.g. Jockie Music) — their now-playing
		// embeds carry no moderation signal.
		AI_SKIP_ANALYSIS_USER_IDS: z
			.string()
			.default("411916947773587456")
			.transform((v) => v.split(",").filter(Boolean))
			.describe("User IDs to skip AI analysis for (captured but not analyzed)"),
		// Channel IDs whose messages are never AI-analyzed. Unlike
		// EXCLUDED_CHANNEL_IDS these are still CAPTURED and still shown on the
		// dashboard — only the judgement is withheld, and the message lands in the
		// terminal `skipped` state so it is never re-claimed.
		//
		// This is for channels that are deliberately outside moderation: a
		// bot-dedicated channel, where the traffic is command output rather than
		// conversation. Use EXCLUDED_CHANNEL_IDS instead when the channel should
		// be invisible to the dashboard too.
		//
		// A thread inherits its parent's id, so listing a channel also exempts
		// every thread under it (messages.channel_id stores the parent).
		//
		// Entries are trimmed because this list is hand-edited as a CI secret
		// (`a, b` is the natural way to write it) and an untrimmed id would match
		// nothing — the channel would stay moderated with no error anywhere.
		AI_SKIP_ANALYSIS_CHANNEL_IDS: z
			.string()
			.default("")
			.transform((v) =>
				v
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean),
			)
			.describe(
				"Channel IDs to skip AI analysis for (captured, never analyzed)",
			),

		// Thread IDs exempt from AI analysis, with the same terminal `skipped`
		// treatment as the channel list above.
		//
		// This list exists because the channel list CANNOT express it:
		// `messages.channel_id` stores the PARENT for a thread
		// (getMessageLocation writes parentId), so a thread id added to
		// AI_SKIP_ANALYSIS_CHANNEL_IDS matches nothing and the thread stays
		// moderated with no error anywhere. `messages.thread_id` carries the
		// thread's own id, and the worker matches on that here.
		//
		// Trimmed for the same reason as the list above: hand-edited CI secret.
		AI_SKIP_ANALYSIS_THREAD_IDS: z
			.string()
			.default("")
			.transform((v) =>
				v
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean),
			)
			.describe(
				"Thread IDs to skip AI analysis for (captured, never analyzed)",
			),

		// ── Server ───────────────────────────────────────────────────────────
		METRICS_PORT: z.coerce.number().positive().default(9090),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
		// The logger reads LOG_LEVEL straight from process.env so that it cannot
		// depend on this module loading successfully — but the dashboard's config
		// endpoint reports it, so the schema declares it too or Zod strips it and
		// the dashboard always shows "info".
		LOG_LEVEL: z
			.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"])
			.default("info"),
		// The HTTP/WS surface the dashboard and oRPC clients connect to. Port 4001
		// is what nginx proxies and what CI's health check probes.
		WEBSERVER_PORT: z.coerce.number().positive().default(3001),

		WEBHOOK_URLS: z
			.string()
			.default("")
			.transform((v) => v.split(",").filter(Boolean)),

		// ── Database (PostgreSQL) ────────────────────────────────────────────
		DATABASE_URL: z.string().optional(),
		POSTGRES_HOST: z.string().default("localhost"),
		POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
		POSTGRES_USER: z.string().optional(),
		POSTGRES_PASSWORD: z.string().optional(),
		POSTGRES_DB: z.string().optional(),
		// Idle-pool floor. Kept at 0 so the long-lived gateway processes (the
		// selfbot and the moderation worker, each owning its own pg Pool) do not
		// hold ~10 permanently open idle connections to PgBouncer. The pool still
		// grows on demand up to POSTGRES_POOL_MAX; min:0 only drops idle clients
		// after idleTimeoutMillis. This both trims RSS and frees PgBouncer slots.
		POSTGRES_POOL_MIN: z.coerce.number().int().min(0).default(0),
		// Ceiling for the gateway's per-process pg Pool. Each process owns its own
		// pool (the selfbot and the moderation worker), so this value is the
		// per-process cap. Kept at 10 (2026-09-09 audit): the real
		// bottleneck is PgBouncer's per-(user,db) default_pool_size on imrnes —
		// raising this ceiling without raising the Bouncer pool just makes more
		// clients queue at the same 20 slots. pool_mode=session means each pg
		// Pool client occupies a Bouncer slot for the whole transaction; min:0
		// + idleTimeoutMillis frees idle slots automatically.
		POSTGRES_POOL_MAX: z.coerce.number().int().positive().default(10),

		// ── Redis ────────────────────────────────────────────────────────────
		REDIS_URL: z.string().default("redis://localhost:6379"),

		// ── Backlog sync ────────────────────────────────────────────────────
		BACKLOG_SYNC_HOURS: z.coerce.number().positive().default(24),
		BACKLOG_SYNC_BATCH_SIZE: z.coerce
			.number()
			.int()
			.positive()
			.max(100)
			.default(100),

		// ── Attachments ─────────────────────────────────────────────────────
		TELE_UPLOAD_URL: z
			.string()
			.url()
			.default("https://upload.asepharyana.my.id/api/upload"),
		ATTACHMENT_UPLOAD_TIMEOUT_MS: z.coerce.number().positive().default(30000),
		ATTACHMENT_MAX_SIZE_MB: z.coerce.number().positive().default(100),
		ATTACHMENT_RETRY_ATTEMPTS: z.coerce.number().positive().default(3),

		// ── AI Analysis ─────────────────────────────────────────────────────
		AI_LLM_API_KEY: z.string().optional(),
		// 9router — the OpenAI-compatible router on this host (127.0.0.1:4014).
		// Loopback on purpose: the gateway runs on the same machine as 9router,
		// so no TLS/proxy hop is needed (and localhost bypasses 9router's
		// remote-key guard). Public alias https://9router.asepharyana.my.id/v1
		// works too but requires the key for every call.
		AI_LLM_BASE_URL: z.string().url().default("http://127.0.0.1:4014/v1"),
		AI_LLM_MODEL: z.string().default("text"),
		// ── Vision (multimodal) pass ─────────────────────────────────────────
		//
		// The vision pass sends REAL image content blocks, so it needs its own
		// model alias, and optionally its own credentials/endpoint. These three
		// used to exist in the deployment env but were absent from this schema —
		// Zod strips unknown keys, so they were silently dropped and the vision
		// call fell back to the text model with the URL as a *string*, which the
		// model answers with "Tidak dapat memproses URL gambar". Every image
		// message therefore reached moderation with zero visual evidence.
		AI_LLM_VISION_MODEL: z.string().default("text"),
		AI_LLM_VISION_BASE_URL: z.string().url().optional(),
		AI_LLM_VISION_API_KEY: z.string().optional(),
		AI_LLM_DISABLE_THINKING: z
			.string()
			.default("true")
			.transform((v) => v === "true")
			.describe(
				"Disable LLM chain-of-thought (reasoning/thinking) to speed up AI analysis. Set false to restore thinking.",
			),
		AI_LLM_MEDIA_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
		AI_LLM_MAX_COMPLETION_TOKENS: z.coerce
			.number()
			.int()
			.positive()
			.default(16384),
		// Standalone image/sticker/emoji vision analysis (analyzeSingleMediaImage
		// → llmVision → llmChat). Decoupled from the media *batch* timeout above so
		// a single vision call can be tuned independently. 2 minutes by default —
		// vision models (especially behind a router) need headroom for large images
		// and the media batch budget grew to 120s (2026-09-09) so single-image calls
		// must not be the bottleneck in the fallback chain.
		AI_LLM_VISION_ANALYSIS_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(120_000),

		// ── Hindsight memory (moderation context) ───────────────────────────
		//
		// The moderation model otherwise judges each message from that message
		// alone. Hindsight gives it what the guild has already established — who
		// the regular music bot is, what a channel treats as routine — as a
		// `<memory_context>` block ahead of the messages.
		//
		// Always on, and every failure path returns "" so a missing instance costs
		// context, never a verdict.
		// The Hindsight HTTP API. NOT Hermes's memory bank: it points at the
		// self-hosted instance on imrnes (Tailscale 100.121.180.82), which also
		// serves Hermes's own `hermes` bank. Moderation writes untrusted Discord
		// content into this store, so it must never share a bank with an
		// assistant's personal memory — a message author could steer it, and a
		// recall could pull the operator's own facts into a public prompt.
		AI_MEMORY_BASE_URL: z.string().url().default("http://127.0.0.1:8890"),
		AI_MEMORY_BANK_ID: z.string().default("gmw-moderation"),
		// Token budget for one recall. Small on purpose: this is prompt context
		// added to every batch, not a report. Measured latency at `low` is ~0.7s.
		AI_MEMORY_RECALL_MAX_TOKENS: z.coerce
			.number()
			.int()
			.positive()
			.default(1200),
		AI_MEMORY_RECALL_BUDGET: z.enum(["low", "mid", "high"]).default("low"),
		// Deadline for recall. Counted against the moderation call, so it stays
		// small: recall is an enhancement and must not eat the LLM budget.
		AI_MEMORY_RECALL_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(8000),
		// Cap on retained items per batch, so one pathological batch cannot post
		// an unbounded number of documents.
		AI_MEMORY_RETAIN_BATCH_SIZE: z.coerce.number().int().positive().default(40),

		// ── KBBI dictionary (grounding for Indonesian words) ────────────────
		//
		// The model judges Indonesian slang by guessing. "kontol" as banter and
		// "kontol" as sexual are the same bare word to a model with no dictionary,
		// so it invents a meaning and then judges the message from the invention.
		// The KBBI API returns the official senses, which is the difference between
		// grounding and confabulation.
		//
		// A missing dictionary costs grounding, never a verdict: every failure path
		// degrades to no definitions rather than throwing.
		// The kbbi-api HTTP service, published on imrnes. Not Hermes's memory
		// instance and not the public host: an internal read-only lookup.
		AI_DICTIONARY_BASE_URL: z
			.string()
			.url()
			.default("http://100.121.180.82:4020"),
		// Deadline for one lookup. Counted against the moderation call's lease, so
		// it stays well under AI_ANALYSIS_LLM_TIMEOUT_MS: a dictionary is not worth
		// losing a batch of verdicts over.
		AI_DICTIONARY_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
		// Words per request. The API repeats `words=` per word, so this is a
		// URL-length budget as much as a rate one.
		AI_DICTIONARY_MAX_WORDS: z.coerce
			.number()
			.int()
			.positive()
			.max(128)
			.default(24),
		// Words taken from ONE message. A long message holds dozens of distinct
		// words, and looking up all of them spends the budget on function words
		// whose definitions teach the model nothing.
		AI_DICTIONARY_MAX_WORDS_PER_MESSAGE: z.coerce
			.number()
			.int()
			.positive()
			.default(8),
		// Rendered characters per word. A KBBI entry runs to thousands of chars
		// across every homonym and sense; the first senses carry the meaning and
		// the rest crowds out the messages themselves.
		AI_DICTIONARY_MAX_CHARS_PER_WORD: z.coerce
			.number()
			.int()
			.positive()
			.default(300),
		// Total rendered characters for the whole batch. This is the real ceiling
		// on prompt growth: N messages x M words each, capped here.
		AI_DICTIONARY_MAX_CHARS_PER_BATCH: z.coerce
			.number()
			.int()
			.positive()
			.default(2000),

		// ── AI Analysis Timing ──────────────────────────────────────────────
		// ── Moderation worker ──────────────────────────────────────────────
		//
		// The scheduler, the text/media lanes, the per-conversation locks, the
		// cooldown maps and the circuit breaker are all gone. What is left is a
		// claim loop, and these are the only knobs it has. Each one exists because
		// the worker reads it — there is no configuration for a subsystem that
		// no longer exists.
		//
		// Messages claimed per LLM call. Larger batches are cheaper per message
		// but risk a timeout that loses the whole batch's work.
		AI_ANALYSIS_MAX_BATCH_SIZE: z.coerce.number().int().positive().default(25),
		// How long a claim is held. The worker asserts at construction that this
		// covers the WHOLE batch: the vision pre-pass plus the moderation call.
		//
		// The pre-pass runs at AI_LLM_MEDIA_MAX_CONCURRENT wide, so a fully-media
		// batch pays visionTimeoutMs once PER WAVE, not once — the check below
		// multiplies out ceil(batch / concurrency). Checking only one call was a
		// 4.3x understatement at the old defaults (10 waves x 120s + 90s = 1290s
		// under a 300s lease), which is the same duplicate-work failure the
		// assertion exists to prevent, reintroduced through a smaller arithmetic
		// mistake.
		AI_ANALYSIS_PROCESSING_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(1500000),
		// Deadline for one LLM call.
		AI_ANALYSIS_LLM_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(90000),
		// Poll interval when the queue is empty.
		AI_ANALYSIS_POLL_INTERVAL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(2000),
		// Attempts before a message is parked in 'dead' for a human. This is the
		// only bound on LLM spend per message, and it replaces the old
		// per-lane retry + parse-repair + individual-fallback cascade.
		AI_ANALYSIS_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
		// Base of the exponential backoff; attempt N waits base * 2^(N-1).
		AI_ANALYSIS_RETRY_BACKOFF_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(15000),

		// ── Prompt context ──────────────────────────────────────────────────
		// How many PRECEDING messages are put in the prompt per analysed message.
		// `WorkerConfig` carried a `contextWindow` that nothing read, so the feature
		// was off in production while the config claimed 10 — this env is what
		// makes it real and tunable. 0 is valid (feature off), hence not
		// `.positive()`. Capped at 50: each row is a whole message of prompt, and
		// past roughly that the context costs more than it informs.
		AI_MODERATION_CONTEXT_WINDOW: z.coerce
			.number()
			.int()
			.min(0)
			.max(50)
			.default(10),

		// ── Auto Delete ─────────────────────────────────────────────────────
		AUTO_DELETE_FLAGGED_DELAY_MS: z.coerce.number().min(0).default(0),
		AUTO_DELETE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
		AUTO_DELETE_ALLOWED_CATEGORIES: z.string().default(""),
		AUTO_DELETE_EXCLUDED_CHANNEL_IDS: z.string().default(""),
		AUTO_DELETE_EXCLUDED_USER_IDS: z.string().default(""),
		AUTO_DELETE_LOG_CHANNEL_ID: z.string().default(""),

		// ── Nickname Reset (offensive_username enforcement) ────────────────
		// When the only violation is the member's server nickname, reset the
		// nickname to the default username instead of deleting the message.
		AUTO_NICKNAME_RESET_COOLDOWN_MS: z.coerce
			.number()
			.positive()
			.default(10 * 60 * 1000),

		// ── Retention ───────────────────────────────────────────────────────
		RETENTION_MESSAGES_DAYS: z.coerce.number().int().min(0).default(0),
		RETENTION_ATTACHMENTS_DAYS: z.coerce.number().int().min(0).default(0),
		RETENTION_CLEANUP_INTERVAL_MS: z.coerce
			.number()
			.positive()
			.default(24 * 60 * 60 * 1000),
	})
	.superRefine((value, ctx) => {
		if (!value.AI_LLM_API_KEY) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["AI_LLM_API_KEY"],
				message: "AI_LLM_API_KEY is required",
			})
		}

		// A claim lease shorter than the worst-case batch time means a slow call
		// outlives its own claim: the sweeper hands the messages to a second
		// worker while the first is still paying for them. That reintroduces
		// exactly the duplicate-verdict class this design exists to make
		// impossible, so it is rejected at boot rather than discovered in
		// production.
		//
		// The worst case covers the WHOLE batch: the vision pre-pass, which runs
		// once per WAVE because it is capped at AI_LLM_MEDIA_MAX_CONCURRENT in
		// flight, and then the single moderation call.
		{
			const waves = Math.ceil(
				value.AI_ANALYSIS_MAX_BATCH_SIZE /
					Math.max(1, value.AI_LLM_MEDIA_MAX_CONCURRENT),
			)
			const worstCase =
				waves * value.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS +
				value.AI_ANALYSIS_LLM_TIMEOUT_MS
			if (value.AI_ANALYSIS_PROCESSING_TIMEOUT_MS <= worstCase) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["AI_ANALYSIS_PROCESSING_TIMEOUT_MS"],
					message:
						"AI_ANALYSIS_PROCESSING_TIMEOUT_MS (the claim lease) must be greater than the " +
						"worst-case batch time: " +
						`ceil(${value.AI_ANALYSIS_MAX_BATCH_SIZE} / ${value.AI_LLM_MEDIA_MAX_CONCURRENT}) ` +
						`vision waves x ${value.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS}ms + ` +
						`${value.AI_ANALYSIS_LLM_TIMEOUT_MS}ms = ${worstCase}ms, ` +
						"otherwise a media batch is reclaimed and reprocessed while still in flight",
				})
			}
		}

		// Validate database configuration
		if (!value.DATABASE_URL && !value.POSTGRES_HOST) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["DATABASE_URL"],
				message: "Either DATABASE_URL or POSTGRES_HOST must be provided",
			})
		}
	})

export type AppConfig = z.infer<typeof configSchema> & {
	EFFECTIVE_TEXT_GUILD_ID?: string
	EFFECTIVE_MONITOR_GUILD_IDS: string[]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	try {
		const parsed = configSchema.parse(env)
		return {
			...parsed,
			EFFECTIVE_TEXT_GUILD_ID: parsed.TEXT_GUILD_ID ?? parsed.MONITOR_GUILD_ID,
			EFFECTIVE_MONITOR_GUILD_IDS:
				parsed.MONITOR_GUILD_IDS.length > 0
					? parsed.MONITOR_GUILD_IDS
					: parsed.MONITOR_GUILD_ID
						? [parsed.MONITOR_GUILD_ID]
						: [],
		}
	} catch (error) {
		if (error instanceof z.ZodError) {
			const messages = error.issues
				.map((e) => `${e.path.join(".")}: ${e.message}`)
				.join("\n")
			throw new ConfigError(`Configuration validation failed:\n${messages}`)
		}
		throw error
	}
}

/** Singleton config loaded from process.env at import time. */
export const config = loadConfig()
