/**
 * Unified configuration schema shared by all services.
 *
 * This is the single source of truth for all environment variables.
 * Individual services re-export from here; they do NOT define their own schemas.
 */

import { z } from "zod";
import { ConfigError } from "../errors/index.js";

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

    AVATAR_SIZE: z.coerce.number().positive().default(64),

    // ── Server ───────────────────────────────────────────────────────────
    WEBSERVER_PORT: z.coerce.number().positive().default(3001),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["error", "warn", "info", "http", "verbose", "debug", "silly"])
      .default("info"),
    VERBOSE: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
    ADMIN_PASSWORD: z.string().default("admin123"),
    WEBHOOK_URLS: z
      .string()
      .default("")
      .transform((v) => v.split(",").filter(Boolean)),
    WEBHOOK_EVENTS: z
      .string()
      .default("message_flagged,auto_deleted,high_severity")
      .transform((v) => v.split(",").filter(Boolean)),
    METRICS_PORT: z.coerce.number().positive().default(9090),

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
    // ── Wikipedia (web-search / glossary source) ─────────────────────────
    // Native fetch to Wikipedia REST + Action APIs — no SearXNG dependency.
    // Language for summaries/search (e.g. "id", "en").
    WIKIPEDIA_LANG: z.string().min(1).default("id"),
    // Per-request timeout (ms) for Wikipedia API calls.
    WIKIPEDIA_TIMEOUT_MS: z.coerce.number().positive().default(8000),
    // ── TinyFish web search (fallback when Wikipedia misses) ─────────────
    // GET {base}?query=..&location=..&language=.. with X-API-Key header.
    // Empty key = fallback disabled (Wikipedia-only, tests stay offline).
    TINYFISH_API_KEY: z.string().optional().default(""),
    TINYFISH_SEARCH_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),
    TINYFISH_SEARCH_BASE_URL: z
      .string()
      .url()
      .default("https://api.search.tinyfish.ai"),
    TINYFISH_SEARCH_TIMEOUT_MS: z.coerce.number().positive().default(10000),
    TINYFISH_SEARCH_LOCATION: z.string().min(1).default("US"),
    TINYFISH_SEARCH_LANGUAGE: z.string().min(1).default("en"),

    // ── Connection ───────────────────────────────────────────────────────
    RECONNECT_TIMEOUT_MS: z.coerce.number().positive().default(5000),

    // ── Attachments ─────────────────────────────────────────────────────
    TELE_UPLOAD_URL: z
      .string()
      .url()
      .default("https://upload.asepharyana.my.id/api/upload"),
    ATTACHMENT_UPLOAD_TIMEOUT_MS: z.coerce.number().positive().default(30000),
    ATTACHMENT_MAX_SIZE_MB: z.coerce.number().positive().default(100),
    ATTACHMENT_RETRY_ATTEMPTS: z.coerce.number().positive().default(3),
    BACKLOG_SYNC_HOURS: z.coerce.number().positive().default(24),
    BACKLOG_SYNC_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .max(100)
      .default(100),

    // ── AI Analysis ─────────────────────────────────────────────────────
    AI_ANALYSIS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
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
    AI_LLM_MAX_CONCURRENT: z.coerce.number().int().positive().default(8),
    // Media-lane LLM concurrency cap (2026-09-24): vision + media-batch calls
    // use their OWN semaphore instead of sharing AI_LLM_MAX_CONCURRENT, so a
    // slow image backlog can never consume the text lane's concurrency slots.
    // Default 4 keeps media churn from saturating the router; text inference
    // keeps its full AI_LLM_MAX_CONCURRENT (default 8) regardless.
    AI_LLM_MEDIA_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
    AI_LLM_IMAGE_MAX_DIMENSION: z.coerce
      .number()
      .int()
      .positive()
      .default(1024),
    AI_LLM_TEXT_BATCH_SIZE: z.coerce.number().int().positive().default(60),
    AI_LLM_MAX_COMPLETION_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(16384),
    AI_LLM_MEDIA_ANALYSIS_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(120_000),
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
    // Text-only moderation batches are cheaper than media (no downloads /
    // vision pre-pass), so they get their own (shorter) timeout instead of
    // being tied to the media budget. Raised 45s→75s (2026-09-09): the text
    // model behind the router regularly exceeds 45s on long context batches,
    // and the individual-fallback re-run adds another full timeout cycle
    // before marking the message exhausted. 75s is still bounded and keeps
    // the status queue from piling up.
    AI_LLM_TEXT_ANALYSIS_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(75_000),
    // Term glossary — per-word Wikipedia lookups (via SearXNG) for words the
    // LLM may not know (slang, jargon, regional language, foreign terms).
    // Definitions are cached (in-memory + Redis) so repeat lookups are fast.
    // Disable to skip glossary lookups entirely and analyze without them.
    AI_GLOSSARY_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),
    // Max glossary terms looked up per analysis batch (keeps latency bounded).
    AI_GLOSSARY_MAX_TERMS: z.coerce.number().int().min(1).max(20).default(6),
    // Per-user personal profile summaries (userProfileLearner). Disabled by
    // default: profiles bloat the analysis context and add LLM/DB cost for
    // little moderation signal — user history context (last flagged messages)
    // is injected via <user_history> instead of a numeric trust score.
    AI_USER_PROFILE_LEARNING_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
    // Min word length for a term to be considered glossary-worthy.
    AI_GLOSSARY_MIN_WORD_LENGTH: z.coerce
      .number()
      .int()
      .min(2)
      .max(20)
      .default(5),

    // ── Hindsight memory (moderation context) ───────────────────────────
    //
    // The moderation model otherwise judges each message from that message
    // alone. Hindsight gives it what the guild has already established — who
    // the regular music bot is, what a channel treats as routine — as a
    // `<memory_context>` block ahead of the messages.
    //
    // Off by default: this is an enhancement, and a missing instance must
    // never be able to stop a verdict. Every failure path returns "" and the
    // batch is judged on its own evidence.
    AI_MEMORY_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
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
    // How long a claim is held. MUST exceed AI_ANALYSIS_LLM_TIMEOUT_MS, or a
    // slow call outlives its lease and a second worker re-processes messages
    // that are still in flight. The worker asserts this at construction.
    // The claim lease. It must exceed the vision pre-pass PLUS the moderation
    // call, because `analyze()` runs vision first for any batch containing
    // media and both hold the same lease. The default was 120s against a
    // 120s vision budget and a 90s moderation budget — a 210s worst case
    // under a 120s lease, so every media batch was reclaimed and re-processed
    // by a second worker mid-flight.
    AI_ANALYSIS_PROCESSING_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(300000),
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
    AUTO_DELETE_FLAGGED_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),
    AUTO_DELETE_FLAGGED_DRY_RUN: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
    AUTO_DELETE_FLAGGED_DELAY_MS: z.coerce.number().min(0).default(0),
    AUTO_DELETE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
    AUTO_DELETE_ALLOWED_SEVERITIES: z
      .string()
      .default("critical,high,medium,low"),
    AUTO_DELETE_ALLOWED_CATEGORIES: z.string().default(""),
    AUTO_DELETE_EXCLUDED_CHANNEL_IDS: z.string().default(""),
    AUTO_DELETE_EXCLUDED_USER_IDS: z.string().default(""),
    AUTO_DELETE_NOTIFY_USER: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(false),
    AUTO_DELETE_LOG_CHANNEL_ID: z.string().default(""),

    // Publish newly-written verdicts to the dashboard over Redis.
    //
    // The moderation worker is database-only by design, so it announces
    // nothing. This is the gateway's poll of the `verdicts` table that turns
    // each new judgement into a `message_analyzed` event. Without it the
    // dashboard's live feed is frozen at whatever the server render fetched
    // and a freshly-captured message shows as "unjudged" until a manual
    // reload.
    VERDICT_NOTIFY_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),

    // ── Nickname Reset (offensive_username enforcement) ────────────────
    // When the only violation is the member's server nickname, reset the
    // nickname to the default username instead of deleting the message.
    AUTO_NICKNAME_RESET_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),
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
    RETENTION_DRY_RUN: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),
    AUTO_MIGRATE_ON_STARTUP: z
      .string()
      .optional()
      .transform((v) => v === "true")
      .default(true),
  })
  .superRefine((value, ctx) => {
    if (!value.AI_ANALYSIS_ENABLED) {
      // skip: AI analysis not enabled
    } else if (!value.AI_LLM_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AI_LLM_API_KEY"],
        message: "AI_LLM_API_KEY is required when AI_ANALYSIS_ENABLED=true",
      });
    }

    // A claim lease shorter than the LLM timeout means a slow call outlives
    // its own claim: the sweeper hands the messages to a second worker while
    // the first is still paying for them. That reintroduces exactly the
    // duplicate-verdict class this design exists to make impossible, so it is
    // rejected at boot rather than discovered in production.
    // The lease must cover the WHOLE batch: the vision pre-pass and the
    // moderation call both run under it, and a media batch pays both.
    if (value.AI_ANALYSIS_ENABLED) {
      const worstCase =
        value.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS +
        value.AI_ANALYSIS_LLM_TIMEOUT_MS;
      if (value.AI_ANALYSIS_PROCESSING_TIMEOUT_MS <= worstCase) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AI_ANALYSIS_PROCESSING_TIMEOUT_MS"],
          message:
            "AI_ANALYSIS_PROCESSING_TIMEOUT_MS (the claim lease) must be greater than " +
            "AI_LLM_VISION_ANALYSIS_TIMEOUT_MS + AI_ANALYSIS_LLM_TIMEOUT_MS " +
            `(${value.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS} + ${value.AI_ANALYSIS_LLM_TIMEOUT_MS} = ${worstCase}), ` +
            "otherwise a media batch is reclaimed and reprocessed while still in flight",
        });
      }
    }

    // Validate database configuration
    if (!value.DATABASE_URL && !value.POSTGRES_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "Either DATABASE_URL or POSTGRES_HOST must be provided",
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema> & {
  EFFECTIVE_TEXT_GUILD_ID?: string;
  EFFECTIVE_MONITOR_GUILD_IDS: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    const parsed = configSchema.parse(env);
    return {
      ...parsed,
      EFFECTIVE_TEXT_GUILD_ID: parsed.TEXT_GUILD_ID ?? parsed.MONITOR_GUILD_ID,
      EFFECTIVE_MONITOR_GUILD_IDS:
        parsed.MONITOR_GUILD_IDS.length > 0
          ? parsed.MONITOR_GUILD_IDS
          : parsed.MONITOR_GUILD_ID
            ? [parsed.MONITOR_GUILD_ID]
            : [],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new ConfigError(`Configuration validation failed:\n${messages}`);
    }
    throw error;
  }
}

/** Singleton config loaded from process.env at import time. */
export const config = loadConfig();
