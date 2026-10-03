/**
 * v2 moderation worker — the durable half of moderation.
 *
 * ## What replaced what
 *
 * v1 kept the work queue as in-process state: a `Map` of pending
 * conversations, a scheduler interval per lane, cooldown timestamps, a
 * conversation-level lock, and a global circuit-breaker counter. None of that
 * survives a restart, which is the mechanism behind every "message got stuck"
 * report: the row is committed to Postgres as `processing`, and the process
 * that owned the timer is gone.
 *
 * v2 keeps nothing. The queue IS the `ai_status` column. A worker asks the
 * database for claimable work, holds a time-boxed lease while it processes,
 * and the database hands the work to someone else if the lease lapses. A
 * worker can be killed at any instant with no lost work and no duplicated
 * verdict, because correctness is enforced by `claim_messages` and the
 * deferred trigger, not by this file's control flow.
 *
 * ## Module-local state, deliberately
 *
 * Only two things live here: the worker identity (a random id, so a restarted
 * process does not inherit a dead worker's claims) and the poll loop itself.
 * Neither affects correctness.
 */

import { randomUUID } from "node:crypto";
import pLimit from "p-limit";
import type { Pool, PoolClient } from "pg";
import { createChildLogger } from "@/shared/logger/index";
// Link/embed pairing lives with the other capture→prompt helpers, and the two
// escaping helpers used to be duplicated here. Both are re-exported below so
// existing importers of this module keep working.
import {
  escapeMessageBody,
  escapeXmlAttr,
  formatChannelContextForPrompt,
  formatLinkEvidenceForPrompt,
} from "../message-capture/messageMetadata.js";
import {
  selectBatchDictionaryWords,
  selectDictionaryWords,
} from "./dictionary-words.js";
import {
  type DictionaryEntry,
  formatDefinitions,
  type KbbiDictionary,
} from "./kbbiDictionary.js";
import type { LlmGateway } from "./llmGateway.js";
import type { ModerationMemoryBank } from "./memoryBank.js";
import {
  extractMemoryAuthor,
  extractMemoryContext,
  formatAuthorForPrompt,
  type MemoryMessage,
} from "./memoryBank.js";
import { buildSystemPrompt } from "./policy.js";
import {
  logBatchResult,
  logClaimed,
  logCycle,
  logLlmDone,
  logMemoryRecall,
  logMessageRequeued,
  logParked,
  logVerdictWritten,
  traceId,
} from "./trace.js";
import type { ParseBatchResult, ParsedVerdict } from "./verdictParser.js";
import { parseVerdicts } from "./verdictParser.js";

export { escapeMessageBody, escapeXmlAttr };

const log = createChildLogger("ai-moderation");

/**
 * How long a message in an NSFW channel waits before being offered again.
 * Long enough that the loop does not spin on it, short enough that turning
 * the channel flag off takes effect promptly.
 */
const NSFW_RETRY_DELAY_MS = 300_000;

export type MessageState =
  | "pending"
  | "claimed"
  | "analyzed"
  | "retry_wait"
  | "dead"
  | "skipped";

export type ClaimedMessage = {
  id: string;
  guildId: string;
  channelId: string;
  /**
   * The thread's OWN id, or null for a plain channel message.
   *
   * Distinct from `channelId`, which holds the PARENT id when the message
   * came from a thread (getMessageLocation writes parentId into channel_id).
   */
  threadId: string | null;
  authorId: string;
  content: string;
  /**
   * `messages.created_at` is a bigint of epoch MILLISECONDS, and node-postgres
   * returns bigint as a STRING. This was typed `Date`, which is simply false —
   * anything calling `.toISOString()` on it would have thrown at runtime. It is
   * a string here, and `isoFromEpoch` / `toEpochMs` convert it where needed.
   */
  createdAt: string;
  /** Incremented by `claim_messages()` at claim time, so it counts this try. */
  attempts: number;
  username: string | null;
  /**
   * `messages.metadata` — the captured rich evidence (embeds, attachments,
   * stickers, channel, member).
   *
   * THIS FIELD IS THE FIX. The prompt interpolated `content` and nothing
   * else, so a link post reached the model as a bare `t.co` string with the
   * resolved Facebook/Instagram preview sitting unread in this column, and an
   * embedder message whose `content` was `""` was judged as literally empty.
   * `formatLinkEvidenceForPrompt` consumes this to present the link and its
   * preview as one unit.
   */
  metadata: string | null;
  /**
   * True when the channel is marked NSFW on Discord, read from the
   * metadata captured with the message. Such messages are never analysed.
   */
  channelIsNsfw?: boolean | null;

  /** True when the message has at least one attachment row. */
  hasMedia: boolean;
};

export type WorkerConfig = {
  /** How many messages to pull per claim. */
  claimBatchSize: number;
  /** Lease length. Must exceed the worst-case of a whole batch — the vision
   *  pre-pass PLUS the moderation call — or work is reclaimed while still
   *  running and two workers process the same message. */
  leaseMs: number;
  /** How often to poll when the queue is empty. */
  idlePollMs: number;
  /** Attempts before a message is parked in `failed`. */
  maxAttempts: number;
  /** Backoff base; attempt N waits `retryBackoffBaseMs * 2^(N-1)`. */
  retryBackoffBaseMs: number;
  /** Deadline for a single LLM call. */
  llmTimeoutMs: number;
  /**
   * Deadline for the vision pre-pass, which runs BEFORE the moderation call
   * and holds the same lease. A media batch pays both, so the lease has to
   * cover their sum.
   */
  visionTimeoutMs: number;
  /**
   * How many PRECEDING messages to put in the prompt per analysed message.
   *
   * 0 disables the history block. Was declared as `includeContext: boolean`
   * plus `contextWindow: number` and never read by anything — the pair let a
   * deployment set a window of 10 with the flag off and get silence, which is
   * indistinguishable from "no history exists". One number now.
   */
  contextWindow: number;
  /**
   * Channels deliberately excluded from moderation. Their messages are still
   * captured and still visible on the dashboard — they are simply never
   * judged, and land in the terminal `skipped` state.
   *
   * Empty by default, and the empty list skips nothing: the default direction
   * is "moderate", so a mis-set env var can never quietly unmoderate a
   * channel.
   */
  skipChannelIds?: readonly string[];
  /**
   * Same terminal `skipped` treatment, keyed on `messages.thread_id`.
   *
   * Separate from `skipChannelIds` because `messages.channel_id` holds the
   * PARENT id for a thread, so a thread id can never appear in the channel
   * list — it would match nothing and the thread would stay moderated with no
   * error anywhere.
   */
  skipThreadIds?: readonly string[];
  /** Stop after this many batches (0 = run forever). Used by tests. */
  maxBatches?: number;
  /**
   * Ceiling on concurrent vision calls inside one batch's pre-pass.
   *
   * The fan-out used to be a bare `Promise.all` over every message in the
   * batch, so a single media batch opened `claimBatchSize` (40 by default)
   * simultaneous image uploads and completions. AI_LLM_MEDIA_MAX_CONCURRENT
   * was declared in the schema, documented as owning a dedicated semaphore,
   * and read by nothing — so a backlog of images hit the provider as a
   * 40-way burst and the router throttled or dropped the lot.
   */
  visionConcurrency?: number;
};

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  claimBatchSize: 40,
  // Must exceed visionTimeoutMs + llmTimeoutMs (210s here). It was 120s — the
  // value the config default used to carry — so every media batch outlived its
  // own lease and was handed to a second worker mid-flight.
  leaseMs: 300_000,
  idlePollMs: 2_000,
  maxAttempts: 5,
  retryBackoffBaseMs: 15_000,
  llmTimeoutMs: 90_000,
  visionTimeoutMs: 120_000,
  contextWindow: 10,
  // Matches the AI_LLM_MEDIA_MAX_CONCURRENT schema default.
  visionConcurrency: 4,
};

/**
 * A lease shorter than the batch's worst case guarantees duplicate work.
 *
 * The worst case is the vision pre-pass PLUS the moderation call, because
 * `analyze()` runs vision first for any batch containing media and both hold
 * the same lease. The shipped defaults were lease 120s / vision 120s /
 * moderation 90s — a 210s worst case against a 120s lease, so every media
 * batch was handed to a second worker mid-flight, paying for duplicate
 * vision and racing two workers on the same `verdicts` row. The guard that
 * exists to make duplicate verdicts impossible did not cover the path that
 * made them likely.
 */
export function assertLeaseCoversLlmTimeout(cfg: WorkerConfig): void {
  const worstCase = cfg.visionTimeoutMs + cfg.llmTimeoutMs;
  if (cfg.leaseMs <= worstCase) {
    throw new Error(
      `leaseMs (${cfg.leaseMs}) must exceed visionTimeoutMs + llmTimeoutMs ` +
        `(${cfg.visionTimeoutMs} + ${cfg.llmTimeoutMs} = ${worstCase}); ` +
        `otherwise a slow media batch outlives its lease and another worker re-processes the messages`,
    );
  }
}

/**
 * `messages.created_at` is a bigint of milliseconds, not a timestamp column, so
 * node-postgres hands it back as a STRING (or a number for small values) and
 * `.toISOString()` does not exist on it. Prompt timestamps are advisory
 * context, so a malformed one degrades to "unknown" rather than failing the
 * whole batch over a formatting detail.
 */
export function isoFromEpoch(value: unknown): string {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "unknown";
  }
}

export type WorkerStats = {
  batches: number;
  claimed: number;
  analyzed: number;
  retried: number;
  dead: number;
  skipped: number;
  batchFailures: number;
  llmErrors: number;
};

function emptyStats(): WorkerStats {
  return {
    batches: 0,
    claimed: 0,
    analyzed: 0,
    retried: 0,
    dead: 0,
    skipped: 0,
    batchFailures: 0,
    llmErrors: 0,
  };
}

/**
 * Prompt for the vision pass.
 *
 * It asks what the image SHOWS, not whether it is acceptable, and forbids
 * the two useless answers: "the image is unclear" and "there is no text".
 * A vague description is worse than none, because the moderation model
 * treats it as evidence and concludes "clean" from it — so the prompt has
 * to make the vision model commit to concrete detail.
 */
const VISION_SYSTEM_PROMPT = `Kamu adalah Penetras Gambar. Tugasmu MENJELASKAN isi gambar, bukan menilai apakah itu melanggar.

Untuk setiap gambar, tulis 1-2 kalimat faktual dalam Bahasa Indonesia:
- Apa yang terlihat: orang, objek, latar, tempat, dan tulisan di dalam gambar.
- Detail spesifik: siapa saja yang ada, berapa orang, aktivitas apa yang terjadi.
- Kalau ada teks di dalam gambar, tuliskan teksnya.
- Kalau ada bagian tubuh atau kondisi fisik yang tampak, sebutkan.

DILARANG menjawab:
- "gambar tidak jelas" atau "kualitas gambar rendah"
- "tidak ada teks" sebagai satu-satunya jawaban, itu bukan deskripsi
- penilaian moral atau kebijakan; itu tugas moderator, bukan kamu

Kalau memang tidak ada yang bisa dibaca dari gambar, katakan bentuk dan
warna yang terlihat, bukan bahwa gambarnya tidak terbaca.

Output: JSON array berisi SATU string per gambar, urutan sama dengan input.
Contoh: ["Seseorang mengambil selfie, rambut disisir ke belakang, memakai kemeja hitam."]`;

async function generateVisionDescription(
  pool: Pool,
  message: ClaimedMessage,
  visionTimeoutMs: number,
  visionGateway?: LlmGateway,
): Promise<string> {
  // Lazy-import the client so config validation runs first. The gateway is
  // injectable so tests do not depend on a live vision model — the
  // description is the thing under test, not the network round trip.
  //
  // The timeout is passed in rather than read from ambient config, so it is
  // the SAME number the lease assertion checked. Reading it here instead
  // meant the assertion could pass while the call used a longer budget.
  const { createDefaultVisionGateway } = await import("./llmGateway.js");
  try {
    // MUST be the vision gateway, not the text one. The text model has no
    // image capability, and the previous code used it, which is why every
    // image message was judged on an empty description.
    const vision = visionGateway ?? createDefaultVisionGateway();
    // AttachmentsDb needs a NodePgDatabase; the worker only holds
    // a Pool. Query attachments directly — same columns.
    //
    // Only image-ish attachments are sent to the model. A .zip or a .mp4
    // passed as an image_url part makes the provider reject the WHOLE
    // request, which would take down the batch's media description — and
    // with it the moderation verdict for every message in the batch.
    const rows = await pool.query<{
      discord_url: string | null;
      type: string | null;
    }>(`SELECT discord_url, type FROM attachments WHERE message_id = $1`, [
      message.id,
    ]);
    if (!rows.rows.length) return "";
    const urls = rows.rows
      .filter((a) => isVisionCapable(a.type, a.discord_url))
      .map((a) => a.discord_url as string)
      .filter((u) => typeof u === "string" && u.length > 0);
    if (!urls.length) return "";
    const description = await vision.complete({
      system: VISION_SYSTEM_PROMPT,
      user: `Deskripsikan ${urls.length} gambar berikut.`,
      // The image parts, NOT the URLs inlined in the text. A vision model
      // given a URL as text answers "Tidak dapat memproses URL gambar" and
      // describes nothing — verified against the production router. The
      // moderation model then treats that sentence as a description and
      // concludes the image is fine.
      images: urls.map((url) => ({ url })),
      timeoutMs: visionTimeoutMs,
    });
    if (!description || description.trim().length === 0) return "";
    return `\n[Media description: ${description.trim()}]\n`;
  } catch (e) {
    log.warn(
      { messageId: message.id, error: String(e) },
      "Failed to generate vision description — analyzing on text only",
    );
    return "";
  }
}

/**
 * Test seam for the vision pass.
 *
 * `generateVisionDescription` reads config and the vision gateway through
 * dynamic imports, which is right for production but leaves the description
 * itself untestable. This exposes the same code path with both injected.
 */
export async function generateVisionDescriptionForTest(
  pool: Pool,
  message: ClaimedMessage,
  vision: LlmGateway,
  visionTimeoutMs = 120_000,
): Promise<string> {
  return generateVisionDescription(pool, message, visionTimeoutMs, vision);
}

/**
 * Whether an attachment can be handed to a vision model as an image part.
 *
 * Providers reject the entire request on an unsupported media type, so
 * guessing is not an option: a single .zip in the batch would blank out the
 * description for every image alongside it.
 */
export function isVisionCapable(
  contentType: string | null | undefined,
  url?: string | null,
): boolean {
  const type = (contentType ?? "").toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/")) {
    // SVG and the AVIF/HEIC variants are not universally accepted either.
    return !type.includes("svg") && !type.includes("avif");
  }
  if (type) return false;
  // No content type recorded: fall back to the file extension.
  const ext = (url ?? "")
    .split("?")[0]
    .split("#")[0]
    .split(".")
    .pop()
    ?.toLowerCase();
  return ext
    ? ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)
    : false;
}

/** One message from the recent past, as the prompt's history block. */
type HistoryMessage = {
  id: string;
  channelId: string;
  threadId: string | null;
  createdAt: number;
  authorId: string;
  username: string | null;
  content: string;
  /** Whether this row is itself in the batch being judged, not history. */
  inBatch: boolean;
};

/**
 * Load the messages immediately preceding each analysed message.
 *
 * `includeContext`/`contextWindow` existed in `WorkerConfig` with a default of
 * 10 and zero call sites — the feature was declared and never built, so the
 * model judged every message in isolation while the config claimed otherwise.
 * This is that feature.
 *
 * The window is per THREAD, not per channel. `messages.channel_id` holds the
 * parent channel for a thread message, so a channel-wide window would splice
 * an unrelated thread's discussion into the middle of another one — the exact
 * confusion the 2026-10-01 memory rebuild was done to remove. A root-channel
 * message (no `thread_id`) gets its channel-root predecessors instead.
 *
 * One query for the whole batch, not one per message: a 40-message batch would
 * otherwise be 40 round trips inside the moderation call's own lease. It walks
 * each target backwards and stops at `contextWindow` per target, deduplicating
 * as it goes, so the whole window costs one round trip regardless of size.
 *
 * `ORDER BY created_at, id` matches the `(channel_id, created_at, id)` and
 * `(thread_id, created_at, id)` indexes, and `id` breaks ties because Discord
 * snowflakes are monotonic — two messages can share a millisecond.
 *
 * History rows are read from the same table the batch came from, so a message
 * still being processed by another worker can appear. That is harmless: it is
 * text the model would have seen anyway, and it is capped.
 */
async function loadContextHistory(
  pool: Pool,
  batch: readonly ClaimedMessage[],
  window: number,
): Promise<HistoryMessage[]> {
  if (window <= 0 || batch.length === 0) return [];

  // Each target carries its own scope, so a batch spanning a thread and a
  // channel root does not collapse into one of them.
  const targets = batch.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    threadId: m.threadId ?? null,
    createdAt: m.createdAt,
  }));

  // `id` leads the ORDER BY because DISTINCT ON requires it — Postgres keeps
  // whichever row it saw first per id, and every target reaches the same message
  // with the same columns, so which one wins is irrelevant. The result is
  // re-sorted chronologically below rather than trusted from SQL, because
  // `id`-order is chronological only by the accident that Discord snowflakes
  // grow with time.
  const { rows } = await pool.query<HistoryMessage>(
    `WITH targets AS (
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::bigint[]
       ) AS t(id, "channelId", "threadId", "createdAt")
     ),
     reachable AS (
       SELECT t.id AS target_id,
              h.id, h.channel_id, h.thread_id, h.created_at,
              h.user_id, h.username, h.content,
              row_number() OVER (
                PARTITION BY t.id
                ORDER BY h.created_at DESC, h.id DESC
              ) AS depth
         FROM targets t
         JOIN messages h
           ON (
             h.created_at < t."createdAt"
             OR (h.created_at = t."createdAt" AND h.id < t.id)
           )
          AND h.channel_id = t."channelId"
          AND h.thread_id IS NOT DISTINCT FROM t."threadId"
     ),
     capped AS (
       SELECT * FROM reachable WHERE depth <= $5
     )
     SELECT DISTINCT ON (id)
            id, channel_id AS "channelId", thread_id AS "threadId",
            created_at AS "createdAt", user_id AS "authorId",
            username, content, false AS "inBatch"
       FROM capped
      ORDER BY id, created_at, id`,
    [
      targets.map((t) => t.id),
      targets.map((t) => t.channelId),
      targets.map((t) => t.threadId),
      targets.map((t) => t.createdAt),
      window,
    ],
  );

  const inBatch = new Set(batch.map((m) => m.id));
  // Re-sorted here, in the type's terms, so the guarantee does not depend on
  // how the query happened to be written. Chronological, and `id` breaks the
  // tie because two messages can share a millisecond.
  return rows
    .map((r) => ({ ...r, inBatch: inBatch.has(r.id) }))
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt - b.createdAt,
    );
}

/**
 * `loadContextHistory` that cannot fail the batch.
 *
 * Context is an enhancement. A query timeout, a missing index, a bad window —
 * none of those are a reason to leave `attempts` unspent or to park a message
 * as `failed`, because the moderation call itself has everything it needs.
 * Returns "" and lets the prompt be what it was before this feature existed.
 */
async function loadContextHistorySafely(
  pool: Pool,
  batch: readonly ClaimedMessage[],
  window: number,
): Promise<string> {
  if (window <= 0 || batch.length === 0) return "";
  try {
    const history = await loadContextHistory(pool, batch, window);
    if (history.length === 0) return "";
    return formatConversationHistory(history);
  } catch (e) {
    log.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        batchSize: batch.length,
        window,
      },
      "conversation history unavailable — analysing without it",
    );
    return "";
  }
}

/**
 * Render recent messages that PRECEDED the batch, as one closed block.
 *
 * Labelled `<conversation_history>` and deliberately distinct from
 * `<memory_context>`. They answer different questions: memory is what the guild
 * already knows about this place over weeks, history is the ten messages
 * before this one. Collapsing them would make the model unable to tell a
 * precedent from a general norm — and the history rows are the ones it must
 * NOT produce verdicts for.
 *
 * Every row is marked `context="history"`, so the policy can tell the model
 * that these are already judged (or not) and only the `<message>` blocks are
 * up for review. Empty string when there is no history, so the prompt is
 * exactly what it was before this feature existed.
 */
function formatConversationHistory(history: readonly HistoryMessage[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const h of history) {
    if (h.inBatch || seen.has(h.id)) continue;
    seen.add(h.id);
    // Only the CONTENT is sanitised; the attributes are ours and a snowflake id
    // carries no injection risk. Usernames are user-controlled and escaped.
    const who = h.username ? escapeXmlAttr(h.username) : "unknown";
    lines.push(
      `<message id="${h.id}" author="${who}" ts="${isoFromEpoch(h.createdAt)}" context="history">` +
        `\n${escapeMessageBody(h.content)}\n</message>`,
    );
  }
  if (lines.length === 0) return "";
  return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>`;
}

/**
 * Project claimed messages into the shape the memory bank stores.
 *
 * The identity mapping is the point: a `user_id` alone produces the memory
 * "user 1234567890 posted a jackpot link", which no semantic query about a
 * NAME will ever match. `author.username` (global), `author.globalName` and
 * `member.nickname` (server-scoped) all come from the metadata already
 * selected by the claim query.
 *
 * The conversation context rides along from the same metadata blob. Before the
 * 2026-10-01 rebuild it was dropped here, which is why every memory in the bank
 * was "who sent what" with no thread, no channel name and no topic — see the
 * module docblock in `memoryBank.ts`. `extractMemoryContext` reads exactly the
 * keys capture already wrote, so no extra query or column is needed.
 *
 * `verdicts` are absent before analysis, so recall (which runs pre-analysis)
 * passes empty strings and retain (which runs post-persist) passes the real
 * ones. The bank stores what it is given; this function only flattens.
 */
function toMemoryMessages(
  messages: readonly ClaimedMessage[],
  visionById: ReadonlyMap<string, string>,
  verdicts?: ReadonlyMap<string, ParsedVerdict>,
): MemoryMessage[] {
  return messages.map((m) => {
    const v = verdicts?.get(m.id);
    return {
      messageId: m.id,
      guildId: m.guildId,
      channelId: m.channelId,
      content: m.content,
      createdAt: isoFromEpoch(m.createdAt),
      author: extractMemoryAuthor(m.authorId, m.metadata),
      context: extractMemoryContext(m.metadata),
      analysis: v?.analysis ?? "",
      status: v?.status ?? "pending",
      categories: v?.categories ?? [],
      mediaDescription: visionById.get(m.id)?.trim() || undefined,
    };
  });
}

export class ModerationWorker {
  private readonly pool: Pool;
  private readonly llm: LlmGateway;
  /**
   * Describes attached images before moderation. Optional: when absent the
   * shared default client is created on first use, so production wiring is
   * unchanged while tests can inject a stub instead of calling a real model.
   */
  private readonly vision: LlmGateway | undefined;
  /**
   * Hindsight bank supplying what the guild already knows about these
   * channels. Optional for the same reason `vision` is: tests inject a stub,
   * and a deployment without an instance must still produce verdicts.
   */
  private readonly memory: ModerationMemoryBank | undefined;
  /**
   * KBBI, grounding the model on what Indonesian words actually mean.
   *
   * Optional for the same reason `vision` and `memory` are: tests inject a stub,
   * and a deployment without a dictionary must still produce verdicts. Left
   * undefined the prompt is byte-identical to what it was before this existed.
   */
  private readonly dictionary: KbbiDictionary | undefined;
  private readonly config: WorkerConfig;
  readonly workerId: string;
  private stopped = false;
  private loop: Promise<void> | null = null;
  readonly stats: WorkerStats = emptyStats();

  constructor(
    pool: Pool,
    llm: LlmGateway,
    config?: Partial<WorkerConfig>,
    vision?: LlmGateway,
    memory?: ModerationMemoryBank,
    dictionary?: KbbiDictionary,
  ) {
    this.pool = pool;
    this.llm = llm;
    this.vision = vision;
    this.memory = memory;
    this.dictionary = dictionary;
    this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
    assertLeaseCoversLlmTimeout(this.config);
    // A fresh id per process is the point: a restarted worker must not be able
    // to reclaim its own previous leases and reprocess them.
    this.workerId = `w-${randomUUID().slice(0, 8)}`;
    log.info(
      {
        workerId: this.workerId,
        ...this.config,
        dictionary: this.dictionary?.enabled ?? false,
      },
      "moderation worker constructed",
    );
  }

  /** Claim work, process it, write verdicts. Returns false when drained. */
  async runOnce(): Promise<boolean> {
    const cycleStart = Date.now();
    const messages = await this.claim();
    if (messages.length === 0) return false;

    this.stats.batches += 1;
    this.stats.claimed += messages.length;

    // Snapshot the counters so the heartbeat reports THIS cycle, not the
    // process lifetime. A monotonic total is useless for spotting a batch
    // that suddenly gets slow.
    const before = { ...this.stats };
    const trace = traceId(messages[0].id);

    let result: ParseBatchResult;
    let visionById: Map<string, string>;
    try {
      ({ result, visionById } = await this.analyze(messages));
    } catch (e) {
      // The whole LLM call failed (network, timeout, refusal). Every message
      // in the batch takes the same action, and attempts increments so a
      // permanently broken endpoint eventually parks the batch in `failed`
      // instead of retrying forever.
      this.stats.llmErrors += 1;
      await this.handleLlmFailure(messages, e);
      this.logCycle(before, cycleStart, trace, messages.length);
      return true;
    }

    if (result.batchFailed) {
      this.stats.batchFailures += 1;
      await this.handleLlmFailure(
        messages,
        new Error(result.batchError ?? "unparseable response"),
      );
      this.logCycle(before, cycleStart, trace, messages.length);
      return true;
    }

    await this.persist(messages, result, visionById);
    this.logCycle(before, cycleStart, trace, messages.length);
    return true;
  }

  /** Emit one heartbeat per cycle with this cycle's deltas, not lifetime totals. */
  private logCycle(
    before: WorkerStats,
    cycleStart: number,
    trace: string,
    count: number,
  ): void {
    logCycle({
      workerId: this.workerId,
      trace,
      count,
      claimed: this.stats.claimed - before.claimed,
      analyzed: this.stats.analyzed - before.analyzed,
      retried: this.stats.retried - before.retried,
      dead: this.stats.dead - before.dead,
      skipped: this.stats.skipped - before.skipped,
      llmErrors: this.stats.llmErrors - before.llmErrors,
      cycleMs: Date.now() - cycleStart,
    });
  }

  private async claim(): Promise<ClaimedMessage[]> {
    // `has_media` comes from the attachments table, NOT from inspecting
    // message content. v1 inferred media by regexing the text
    // (analysisLanes.ts:17 called hasMediaContent(message) with no attachments
    // argument at all), which is why lane assignment disagreed with the
    // orchestrator and media landed in the text lane.
    // `attempts` MUST come from the function's own RETURNING row, not from a
    // re-read of `messages`. Inside that one statement the join sees the
    // pre-UPDATE snapshot, so `m.attempts` is always one behind — the
    // increment claim_messages() performs is only visible to a later
    // statement. Reading it from `c` gives the post-increment value.
    const { rows: claimed } = await this.pool.query<ClaimedMessage>(
      `SELECT m.id,
              m.guild_id      AS "guildId",
              m.channel_id    AS "channelId",
              m.thread_id     AS "threadId",
              m.user_id       AS "authorId",
              m.content,
              m.created_at    AS "createdAt",
              m.username      AS "username",
              m.metadata      AS metadata,
              c.attempts::int AS "attempts",
              (a.n IS NOT NULL) AS "hasMedia",
              (m.metadata::jsonb -> 'channel' ->> 'nsfw')::boolean AS "channelIsNsfw"
         FROM claim_messages($1, $2, $3) AS c
         JOIN messages m ON m.id = c.id
         LEFT JOIN (
              SELECT message_id, count(*) AS n
                FROM attachments GROUP BY message_id
         ) a ON a.message_id = m.id`,
      [this.workerId, this.config.claimBatchSize, this.config.leaseMs],
    );
    if (claimed.length > 0) logClaimed(this.workerId, claimed);

    // Never analyse or moderate inside a channel Discord marks NSFW.
    //
    // The flag comes from the channel object itself, captured at message
    // time and persisted in messages.metadata -> channel -> nsfw, so this
    // tracks whatever an admin sets in the Discord UI. No hardcoded id
    // list: production shows 4 flagged channels and 6 safe ones, and the
    // set changes whenever an admin edits a channel.
    //
    // Claimed rows are released straight back to pending rather than
    // analyzed — otherwise the claim batch would silently shrink and the
    // worker would spin on the same unanalysable rows every tick.
    const inNsfw = claimed.filter((r) => r.channelIsNsfw === true);
    let rows = claimed;
    if (inNsfw.length > 0) {
      const safe = claimed.filter((r) => r.channelIsNsfw !== true);
      await this.pool.query(
        `UPDATE messages
            SET ai_status = 'skipped',
                worker_id = NULL,
                lease_until = NULL
          WHERE id = ANY($1)`,
        [inNsfw.map((r) => r.id)],
      );
      log.debug(
        { skipped: inNsfw.length, kept: safe.length },
        "skipped NSFW channel messages — never analysed",
      );
      // `safe` still needs the skip-list pass below, so fall through rather
      // than returning here.
      rows = safe;
    }

    // A channel or thread on the skip list is never analysed, and — unlike
    // NSFW — never re-offered. NSFW is a poll, because an admin can toggle the
    // channel at any time and the rule should follow them; the skip list is a
    // decision that does not change on its own, so a re-claim loop is pure
    // waste: 12 claims an hour per message forever, `attempts` climbing past
    // the cap so the row eventually parks as `dead` — reported as a
    // human-needing-a-look message that was in fact never broken — and a
    // backlog gauge that never drains.
    //
    // So it goes to the terminal `skipped` state (migration 0023): no verdict
    // (nothing was judged, so nothing to delete), no retry budget consumed,
    // and `claim_messages` never selects it again.
    //
    // `messages.channel_id` holds the PARENT id for a thread, so the channel
    // list covers threads under an exempt channel for free — the same rule
    // EXCLUDED_CHANNEL_IDS applies at capture time. A single exempt THREAD
    // cannot be expressed that way, which is what skipThreadIds is for.
    const skipChannels = new Set(this.config.skipChannelIds ?? []);
    const skipThreads = new Set(this.config.skipThreadIds ?? []);
    const skipReason = (r: ClaimedMessage): string | null => {
      if (skipChannels.has(r.channelId)) {
        return `channel ${r.channelId} is on AI_SKIP_ANALYSIS_CHANNEL_IDS`;
      }
      if (r.threadId && skipThreads.has(r.threadId)) {
        return `thread ${r.threadId} is on AI_SKIP_ANALYSIS_THREAD_IDS`;
      }
      return null;
    };
    const inSkipped = rows.filter((r) => skipReason(r) !== null);
    if (inSkipped.length > 0) {
      const keep = rows.filter((r) => skipReason(r) === null);
      await this.pool.query(
        `UPDATE messages
            SET ai_status = 'skipped',
                worker_id = NULL,
                lease_until = NULL
          WHERE id = ANY($1)`,
        [inSkipped.map((r) => r.id)],
      );
      this.stats.skipped += inSkipped.length;
      log.info(
        {
          skipped: inSkipped.length,
          kept: keep.length,
          channels: [...skipChannels],
          threads: [...skipThreads],
        },
        "channel or thread is on the skip list — captured, never analysed",
      );
      for (const m of inSkipped) {
        logMessageRequeued({
          trace: traceId(m.id),
          messageId: m.id,
          // Not a requeue: the terminal reason, kept on the same event so one
          // grep on the trace id explains the message's whole life.
          reason: "skipped_by_channel_config",
          detail: skipReason(m) ?? "",
          attempts: m.attempts,
          createdAt: m.createdAt,
        });
      }
      rows = keep;
    }

    if (rows.length === 0) {
      // Everything in this batch was released. Returning false is what makes
      // the poll loop take its idle sleep — otherwise a batch of nothing but
      // skips would report "did work" and spin at full speed.
      return [];
    }
    return rows;
  }

  /** Build the prompt, call the model, parse. Throws only on transport failure. */
  /**
   * Describe each attached image/sticker/video with the vision model.
   *
   * The moderation LLM needs a text description of what the media
   * contains before it can decide whether the message violates
   * server policy. Without this, image-only messages have no evidence
   * to judge and default to clean. This runs the vision model once
   * per message with attachments and returns the description text
   * that the moderation prompt inserts before the message body.
   *
   * Failures here are non-fatal: the message still gets analyzed on
   * its text, and the missing description is noted in the trace.
   */

  private async analyze(
    messages: ClaimedMessage[],
  ): Promise<{ result: ParseBatchResult; visionById: Map<string, string> }> {
    const requestedIds = messages.map((m) => m.id);
    const hasMedia = messages.some((m) => m.hasMedia);

    // NOTE: the system prompt is built LAST, after recall. It has to be,
    // because whether it carries the MEMORY_RULES block depends on whether
    // recall actually produced something. Building it up here — the obvious
    // spot — silently hard-codes `memory: false` for every batch, and the
    // <memory_context> then arrives in the user turn with nothing in the
    // system prompt explaining how to read it.
    //

    // Descriptions are resolved BEFORE the prompt is assembled. The previous
    // version called the vision model inside the .map() and then dropped the
    // result on the floor — the variable was never interpolated into the
    // template, so image messages reached the model with no description at
    // all and the whole feature was inert. It also had to be awaited: the
    // call is async, and an un-awaited promise stringifies to "[object
    // Promise]" in a template literal.
    //
    // All descriptions for the batch are fetched concurrently rather than one
    // at a time, so a batch of ten images does not pay the vision latency ten
    // times over. A failure for one message is contained: the description is
    // empty and that message is still judged on its text.
    const visionById = new Map<string, string>();
    if (hasMedia) {
      // Bounded, not one call per message at once. The concurrency ceiling keeps
      // a 40-message image batch from arriving at the provider as a 40-way
      // burst; p-limit preserves the "all descriptions resolved concurrently"
      // property the old Promise.all comment claimed, up to the cap.
      const limit = pLimit(
        this.config.visionConcurrency ??
          DEFAULT_WORKER_CONFIG.visionConcurrency ??
          1,
      );
      const described = await Promise.all(
        messages.map((m) =>
          limit(async () => {
            if (!m.hasMedia) return [m.id, ""] as const;
            return [
              m.id,
              await generateVisionDescription(
                this.pool,
                m,
                this.config.visionTimeoutMs,
                this.vision,
              ),
            ] as const;
          }),
        ),
      );
      for (const [id, desc] of described) {
        if (desc) visionById.set(id, desc);
      }
    }

    // What the guild already knows about these channels, if anything. One
    // recall for the whole batch, resolved BEFORE the prompt is assembled so
    // the block is interpolated rather than dropped — the same defect the
    // vision descriptions above were written to avoid.
    //
    // Awaited on purpose and bounded by `recallTimeoutMs`: a recall that hangs
    // must not eat the lease, so the deadline lives inside the bank, not here.
    // The lease arithmetic is unchanged because recall is bounded well below
    // `visionTimeoutMs + llmTimeoutMs`.
    const memoryContext = this.memory
      ? await this.memory.recallChannelContext(
          toMemoryMessages(messages, new Map()),
        )
      : "";
    if (memoryContext) {
      logMemoryRecall({
        trace: traceId(messages[0].id),
        channels: [...new Set(messages.map((m) => m.channelId))].length,
        chars: memoryContext.length,
      });
    }

    // Recent predecessors, loaded before the prompt is built so the block can
    // be part of it. One query for the batch; a failure here must not park the
    // messages, so it degrades to no history rather than throwing.
    const historyBlock = await loadContextHistorySafely(
      this.pool,
      messages,
      this.config.contextWindow,
    );

    // KBBI definitions, resolved BEFORE the prompt is assembled for the same
    // reason as the vision descriptions and the recall above: the block has to
    // be interpolated, not merely computed, or the feature is inert while every
    // formatter test still passes.
    //
    // The lookup is per BATCH, not per message — "biji" in five messages is one
    // request — and the results are then indexed back per message so each
    // <message> carries only the definitions for the words IT used. A shared
    // block would let "biji" (seed) explain a message about something else.
    const definitionsById = await this.lookupDefinitions(messages);

    // Built AFTER recall and the dictionary so `memory` and `dictionary`
    // reflect reality. See the note at the top of this method for why the
    // obvious earlier spot is the wrong one.
    const system = buildSystemPrompt({
      mode: hasMedia ? "mixed" : "text",
      memory: memoryContext.length > 0,
      history: historyBlock.length > 0,
      dictionary: definitionsById.size > 0,
    });

    const body = messages
      .map((m) => {
        // Identity as the memory bank knows it. The prompt used to carry
        // `username (user_id)`; that is not enough to correlate with a recall,
        // where the same person appears as "Zulfikar", "zulfik_dev" or
        // "Zul" depending on which name the extraction picked. Carrying all
        // three lets the model tie a memory to the message in front of it.
        const author = extractMemoryAuthor(m.authorId, m.metadata);
        const who = formatAuthorForPrompt(author);
        const vision = visionById.get(m.id) ?? "";
        // The link and its resolved preview, as ONE block. Without this the
        // model saw the `t.co` wrapper and nothing else: it invented a
        // verdict from the domain, and an embedder message (`content: ""`)
        // was reported as an empty message.
        const links = formatLinkEvidenceForPrompt(m.content, m.metadata);
        // NOTE: only the CONTENT is sanitised. The id/author/ts attributes are
        // structured data we generate, and passing the id through
        // sanitizeAiContent would wrap it in <![CDATA[…]]> — which breaks the
        // `<message id="…">` tag the model must echo back, and made the
        // requested-id extraction below find nothing. Message ids are Discord
        // snowflakes (digits only), so they carry no injection risk; author
        // names are user-controlled and therefore escaped with XML entities
        // only, without the CDATA wrapper.
        //
        // The channel's own name/topic/thread ride along as attributes for the
        // same reason: without them the model is asked whether a message suits
        // this channel while never being told what the channel is for. That is
        // what produced a deleted invite-link "unrelated to the channel's topic"
        // verdict in a channel whose topic IS sharing external communities.
        // Empty string on a row captured before these existed, so the tag
        // degrades to exactly what it was.
        const place = formatChannelContextForPrompt(m.metadata);
        // Official senses for the words THIS message used, and no others. The
        // block sits inside the <message> element precisely so a definition
        // cannot drift onto an unrelated message.
        const defs = formatDefinitions(definitionsById.get(m.id) ?? []);
        return (
          `<message id="${m.id}" author="${escapeXmlAttr(who)}" ` +
          `ts="${isoFromEpoch(m.createdAt)}"${place}>\n${vision}` +
          `${escapeMessageBody(m.content)}\n${links}${defs}\n</message>`
        );
      })
      .join("\n");

    const userPrompt =
      `Analisis ${messages.length} pesan berikut dan kembalikan JSON ` +
      `dengan satu entri per message_id di dalam field results.\n\n` +
      // Memory context sits ABOVE the messages so the model reads it as
      // background, not as one more message to judge. Empty when Hindsight is
      // off, unreachable, or has nothing — then the prompt is exactly what it
      // was before this feature existed.
      (memoryContext ? `${memoryContext}\n\n` : "") +
      // History sits BELOW memory and ABOVE the batch, for the same reason: it
      // is background, and every row in it is explicitly marked `context="history"`
      // so the model does not return a verdict for one. Empty when the window is
      // 0 or there is no preceding message.
      (historyBlock ? `${historyBlock}\n\n` : "") +
      `${body}`;

    const llmStart = Date.now();
    const raw = await this.llm.complete({
      system,
      user: userPrompt,
      timeoutMs: this.config.llmTimeoutMs,
    });
    const llmMs = Date.now() - llmStart;

    // The batch's trace id is the FIRST message's id. That is deliberate: one
    // grep for it returns this whole model call, and `ids` below lists every
    // message that went into it, so the sibling ids are discoverable from the
    // same line.
    const trace = traceId(messages[0].id);
    logLlmDone({
      trace,
      batchSize: messages.length,
      model: this.llm.modelLabel ?? "unknown",
      durationMs: llmMs,
      promptChars: system.length + userPrompt.length,
      completionChars: raw.length,
      streamed: true,
      content: raw,
      ids: messages.map((m) => traceId(m.id)),
    });

    const parseStart = Date.now();
    const result = parseVerdicts(raw, requestedIds, 1);
    logBatchResult({
      trace,
      requested: requestedIds.length,
      ok: result.verdicts.length,
      errored: result.verdicts.filter((v) => v.status === "error").length,
      missing: result.missing.length,
      batchFailed: result.batchFailed,
      batchError: result.batchError,
      durationMs: Date.now() - parseStart,
    });
    // The vision map travels back out with the result. It is the only record of
    // what the images contained: the LLM call consumed the descriptions to build
    // the prompt, but the memory bank is written after the commit from the same
    // map, and passing a fresh empty Map there silently dropped every image
    // description from long-term recall.
    return { result, visionById };
  }

  /**
   * Resolve KBBI definitions for a batch, indexed back to each message.
   *
   * Three steps, in this order for three reasons:
   *
   * 1. Select words across the WHOLE batch with the per-message cap applied
   *    first. Selecting per message and concatenating would let one verbose
   *    message take every slot, and the messages that follow it get no grounding
   *    at all — which is backwards, since a long message is usually the one
   *    that needed the help.
   * 2. One `lookup` for all of them, deduplicated by the adapter.
   * 3. Index the returned entries back onto the messages that actually used
   *    each word, so a definition is never offered as an explanation of a
   *    message that did not contain it.
   *
   * Returns an empty map when no dictionary is configured or the lookup yields
   * nothing, which leaves the prompt byte-identical to its pre-dictionary form.
   * The whole method is inside the moderation call's own budget and bounded by
   * the adapter's timeout, so the lease arithmetic is untouched.
   */
  private async lookupDefinitions(
    messages: readonly ClaimedMessage[],
  ): Promise<Map<string, DictionaryEntry[]>> {
    if (!this.dictionary?.enabled) return new Map();
    const { maxWords, maxWordsPerMessage } = this.dictionary.limits;

    const perMessage = new Map<string, string[]>();
    for (const m of messages) {
      const words = selectDictionaryWords(m.content, maxWordsPerMessage);
      if (words.length > 0) perMessage.set(m.id, words);
    }
    if (perMessage.size === 0) return new Map();

    const batch = selectBatchDictionaryWords(
      messages.map((m) => m.content),
      maxWordsPerMessage,
      maxWords,
    );
    if (batch.length === 0) return new Map();

    const found = await this.dictionary.lookup(batch);
    if (found.length === 0) return new Map();

    const byWord = new Map(found.map((e) => [e.word, e] as const));
    const byMessage = new Map<string, DictionaryEntry[]>();
    for (const [messageId, words] of perMessage) {
      const entries: DictionaryEntry[] = [];
      for (const word of words) {
        const entry = byWord.get(word);
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) byMessage.set(messageId, entries);
    }
    log.info(
      {
        trace: traceId(messages[0].id),
        requested: batch.length,
        defined: found.length,
        messages: byMessage.size,
        chars: found.reduce((n, e) => n + e.definition.length, 0),
      },
      "kbbi definitions resolved",
    );
    return byMessage;
  }

  /**
   * Write verdicts and transition state, in ONE transaction.
   *
   * The verdict row must be visible before `ai_status='analyzed'`, because
   * the deferred trigger rejects an analyzed message with no verdict. Both
   * statements therefore share a transaction, and the trigger only fires at
   * COMMIT.
   */
  private async persist(
    messages: ClaimedMessage[],
    result: ParseBatchResult,
    visionById: ReadonlyMap<string, string>,
  ): Promise<void> {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const v of result.verdicts) {
        const msg = byId.get(v.messageId);
        if (!msg) continue;
        await this.writeVerdict(client, msg, v);
      }

      // Messages the model never mentioned stay queued — they are not judged.
      // Their lease is released so another attempt can pick them up.
      //
      // They get the SAME capped, backed-off treatment as a batch failure.
      // This used to set `ready_for_work_at = now` with no backoff and no
      // attempt cap, which combined badly:
      //   - `claim_messages` orders by created_at ASC, so a poison message is
      //     always the oldest row and is re-sent in the FIRST batch of every
      //     cycle;
      //   - `runOnce` returns true after a successful persist, so `start()`
      //     skips its idle sleep entirely;
      //   => an unbounded tight loop of full-price LLM calls for a message
      //      that can never be judged, and the row never reached `dead`, so
      //      an operator had no signal at all.
      if (result.missing.length > 0) {
        await client.query(
          `UPDATE messages
              SET ai_status = CASE
                    WHEN attempts >= $3 THEN 'dead'
                    ELSE 'retry_wait'
                  END,
                  ready_for_work_at =
                    (extract(epoch from now())*1000)::bigint
                    + ($4::bigint * (1 << LEAST(GREATEST(attempts - 1, 0), 20))),
                  worker_id = NULL, lease_until = NULL
            WHERE id = ANY($1::text[]) AND ai_status = 'claimed' AND worker_id = $2`,
          [
            result.missing,
            this.workerId,
            this.config.maxAttempts,
            this.config.retryBackoffBaseMs,
          ],
        );
        for (const id of result.missing) {
          const msg = byId.get(id);
          logMessageRequeued({
            trace: traceId(id),
            messageId: id,
            reason: "omitted_by_model",
            detail: "the model returned no verdict for this message",
            attempts: msg ? msg.attempts : null,
            createdAt: msg?.createdAt,
          });
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      // Leave the rows claimed. The lease lapses and another worker retries
      // them; that is strictly better than guessing which side of the write
      // failed and double-writing a verdict.
      throw e;
    } finally {
      client.release();
    }

    // Store what was just judged. AFTER the commit, and NOT awaited: the
    // verdict row is the source of truth and must not wait on a memory write
    // that can take seconds (measured 3.3s for a 2-item sync retain — this is
    // an LLM extraction on the Hindsight side).
    //
    // An error verdict is stored too. "the model could not read this message"
    // is exactly the sort of recurring, explainable fact worth remembering, and
    // skipping it would make the bank look cleaner than the guild is.
    if (this.memory) {
      const verdictsById = new Map(
        result.verdicts.map((v) => [v.messageId, v] as const),
      );
      this.memory.retainBatch(
        toMemoryMessages(messages, visionById, verdictsById),
      );
    }
  }

  private async writeVerdict(
    client: PoolClient,
    msg: ClaimedMessage,
    v: ParsedVerdict,
  ): Promise<void> {
    const isError = v.status === "error";

    // The auto-delete marker is reset when the judgement materially changes.
    //
    // `auto_delete_state` is the enforcer's "I already looked at this" flag.
    // Once a verdict is marked `done`, a re-judgement that turns a clean
    // message into a deletion would otherwise never be acted on: the enforcer's
    // candidate query only reads NULL or 'pending', and its partial index
    // `idx_verdicts_auto_delete_pending` has the same predicate, so the row is
    // excluded from the index too. A message that gets worse is permanently
    // unenforceable.
    //
    // Reset only on a material change, so a routine re-analysis of an
    // unchanged verdict does not put a settled message back in the queue.
    await client.query(
      `INSERT INTO verdicts
         (message_id, status, reason, score, confidence, flags, categories,
          analysis, evidence, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (message_id) DO UPDATE SET
         status = EXCLUDED.status,
         reason = EXCLUDED.reason,
         score = EXCLUDED.score, confidence = EXCLUDED.confidence,
         flags = EXCLUDED.flags, categories = EXCLUDED.categories,
         analysis = EXCLUDED.analysis, evidence = EXCLUDED.evidence,
         model = EXCLUDED.model,
         auto_delete_state = CASE
           WHEN verdicts.status IS DISTINCT FROM EXCLUDED.status
             OR verdicts.score IS DISTINCT FROM EXCLUDED.score
           THEN NULL
           ELSE verdicts.auto_delete_state
         END,
         auto_delete_claimed_at = CASE
           WHEN verdicts.status IS DISTINCT FROM EXCLUDED.status
             OR verdicts.score IS DISTINCT FROM EXCLUDED.score
           THEN NULL
           ELSE verdicts.auto_delete_claimed_at
         END,
         updated_at = (extract(epoch from now())*1000)::bigint`,
      [
        msg.id,
        isError ? "error" : v.status,
        v.reason ?? null,
        v.score,
        v.confidence,
        v.flags,
        v.categories,
        v.analysis,
        JSON.stringify(v.evidence),
        this.llm.modelLabel ?? null,
      ],
    );

    await client.query(
      `INSERT INTO analysis_attempts
         (message_id, worker_id, attempt, outcome, error_code, error_message, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        msg.id,
        this.workerId,
        // The real attempt number, which claim_messages() already incremented.
        // Hardcoding 1 made the attempt log useless for spotting a message
        // that keeps failing on retry.
        msg.attempts,
        isError ? "parse_error" : "success",
        v.perMessageError ?? null,
        v.perMessageError ? v.analysis : null,
        this.llm.modelLabel ?? null,
      ],
    );

    // An error verdict is a completed judgement ("cannot determine, needs a
    // human"), so the message is terminal — not retried. Only a *batch*
    // failure is retryable, and that path never reaches here.
    await client.query(
      `UPDATE messages
          SET ai_status = 'analyzed', worker_id = NULL, lease_until = NULL
        WHERE id = $1 AND ai_status = 'claimed' AND worker_id = $2`,
      [msg.id, this.workerId],
    );

    if (isError) this.stats.skipped += 1;
    else this.stats.analyzed += 1;

    logVerdictWritten({
      trace: traceId(msg.id),
      messageId: msg.id,
      status: isError ? "error" : v.status,
      score: v.score,
      attempts: msg.attempts,
      createdAt: msg.createdAt,
      perMessageError: v.perMessageError ?? null,
    });
  }

  /**
   * The batch never produced usable results. Reschedule every message with
   * exponential backoff, or park it in `failed` once the attempt cap is hit.
   */
  private async handleLlmFailure(
    messages: ClaimedMessage[],
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    // Every id in the failed batch, so the operator can grep any ONE of them and
    // find the model call that killed it. This is the line that makes a stuck
    // message traceable back to a single bad API response.
    log.warn(
      {
        workerId: this.workerId,
        trace: traceId(messages[0].id),
        stage: "llm-failed",
        count: messages.length,
        ids: messages.map((m) => traceId(m.id)),
        attempts: messages.map((m) => m.attempts),
        err: detail,
      },
      "LLM batch failed; rescheduling with backoff",
    );
    // The raw text is the whole diagnosis for a parse failure ("no results
    // array", "unexpected token <"), and it is invisible at info level.
    log.debug(
      { trace: traceId(messages[0].id), stage: "llm-failed-raw", err: detail },
      "failure detail for the failed batch",
    );

    for (const msg of messages) {
      // `attempts` is incremented by claim_messages at claim time, so by the
      // time we get here it already counts this try. Incrementing again here
      // would consume the retry budget twice per failure and halve the
      // effective attempt cap.
      const { rows } = await this.pool.query<{
        attempts: number;
      }>(
        `UPDATE messages
            SET ai_status = CASE
                  WHEN attempts >= $3 THEN 'dead'
                  ELSE 'retry_wait'
                END,
                ready_for_work_at =
                  (extract(epoch from now())*1000)::bigint
                  -- LEAST(...,20) caps the shift: 1 << n is an int4 shift
                  -- and raises "integer out of range" at n >= 31. A message
                  -- that reached a high attempt count (the omission path used
                  -- to increment without ever parking) made this UPDATE
                  -- throw, the run fail, and the row sit claimed with an
                  -- expired lease — failing identically forever.
                  + ($4::bigint * (1 << LEAST(GREATEST(attempts - 1, 0), 20))),
                worker_id = NULL,
                lease_until = NULL
          WHERE id = $1 AND ai_status = 'claimed' AND worker_id = $2
          RETURNING attempts`,
        [
          msg.id,
          this.workerId,
          this.config.maxAttempts,
          this.config.retryBackoffBaseMs,
        ],
      );
      await this.pool.query(
        `INSERT INTO analysis_attempts
           (message_id, worker_id, attempt, outcome, error_code, error_message, model)
         VALUES ($1, $2,
                 (SELECT attempts FROM messages WHERE id = $1),
                 'llm_error', 'llm_unavailable', $3, $4)`,
        [
          msg.id,
          this.workerId,
          detail.slice(0, 2000),
          this.llm.modelLabel ?? null,
        ],
      );
      const attempts = rows[0]?.attempts ?? msg.attempts;
      const isDead = attempts >= this.config.maxAttempts;
      if (isDead) {
        this.stats.dead += 1;
        logParked({
          trace: traceId(msg.id),
          messageId: msg.id,
          attempts,
          reason: detail.slice(0, 200),
          createdAt: msg.createdAt,
        });
      } else {
        this.stats.retried += 1;
        // Per-message, because "why is this one message still queued?" is the
        // question that gets asked, and it is unanswerable from a batch line.
        logMessageRequeued({
          trace: traceId(msg.id),
          messageId: msg.id,
          reason: "llm_failure",
          detail: detail.slice(0, 200),
          attempts,
          createdAt: msg.createdAt,
        });
      }
    }
  }
  /** Poll until stopped. Reclaims expired leases on the way past. */
  async start(): Promise<void> {
    this.stopped = false;
    this.loop = (async () => {
      let sinceReclaim = 0;
      while (!this.stopped) {
        let didWork = false;
        try {
          didWork = await this.runOnce();
        } catch (e) {
          // Never let one bad batch kill the loop — that is precisely how v1
          // lost work. Log and keep polling.
          log.error(
            {
              workerId: this.workerId,
              err: e instanceof Error ? e.message : e,
            },
            "batch failed; continuing",
          );
        }

        // Reclaim every ~10 idle polls; cheap, and it is what rescues work
        // abandoned by a crashed peer.
        sinceReclaim += 1;
        if (sinceReclaim >= 10) {
          sinceReclaim = 0;
          try {
            const { rows } = await this.pool.query<{
              reclaim_expired_claims: number;
            }>("SELECT reclaim_expired_claims()");
            const n = rows[0]?.reclaim_expired_claims ?? 0;
            if (n > 0) {
              log.info({ reclaimed: n }, "reclaimed expired claims");
            }
          } catch (e) {
            log.warn({ err: e }, "reclaim failed");
          }
        }

        if (!didWork && !this.stopped) {
          await this.sleep(this.config.idlePollMs);
        }
      }
    })();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Release in-flight claims so a peer can take over immediately rather than
    // waiting out the lease.
    try {
      await this.pool.query(
        `UPDATE messages
            SET ai_status = 'pending', worker_id = NULL, lease_until = NULL
          WHERE ai_status = 'claimed' AND worker_id = $1`,
        [this.workerId],
      );
    } catch (e) {
      log.warn({ err: e }, "failed to release claims on stop");
    }
    await this.loop;
  }
}
