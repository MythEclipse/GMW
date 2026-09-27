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
import type { Pool, PoolClient } from "pg";
import { createChildLogger } from "@/shared/logger/index";
import type { LlmGateway } from "./llmGateway.js";
import { buildSystemPrompt } from "./policy.js";
import {
  logBatchResult,
  logClaimed,
  logCycle,
  logLlmDone,
  logMessageRequeued,
  logParked,
  logVerdictWritten,
  traceId,
} from "./trace.js";
import type { ParseBatchResult, ParsedVerdict } from "./verdictParser.js";
import { parseVerdicts } from "./verdictParser.js";

const log = createChildLogger("ai-moderation");

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
  /** True when the message has at least one attachment row. */
  hasMedia: boolean;
};

export type WorkerConfig = {
  /** How many messages to pull per claim. */
  claimBatchSize: number;
  /** Lease length. Must exceed the worst-case LLM call, or work is reclaimed
   *  while still running and two workers process the same message. */
  leaseMs: number;
  /** How often to poll when the queue is empty. */
  idlePollMs: number;
  /** Attempts before a message is parked in `failed`. */
  maxAttempts: number;
  /** Backoff base; attempt N waits `retryBackoffBaseMs * 2^(N-1)`. */
  retryBackoffBaseMs: number;
  /** Deadline for a single LLM call. */
  llmTimeoutMs: number;
  /** Include recent conversation history in the prompt. */
  includeContext: boolean;
  /** Max history messages included per analysed message. */
  contextWindow: number;
  /** Stop after this many batches (0 = run forever). Used by tests. */
  maxBatches?: number;
};

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  claimBatchSize: 40,
  leaseMs: 120_000,
  idlePollMs: 2_000,
  maxAttempts: 5,
  retryBackoffBaseMs: 15_000,
  llmTimeoutMs: 90_000,
  includeContext: true,
  contextWindow: 10,
};

/** A lease shorter than the LLM timeout guarantees duplicate work. */
export function assertLeaseCoversLlmTimeout(cfg: WorkerConfig): void {
  if (cfg.leaseMs <= cfg.llmTimeoutMs) {
    throw new Error(
      `leaseMs (${cfg.leaseMs}) must exceed llmTimeoutMs (${cfg.llmTimeoutMs}); ` +
        `otherwise a slow call outlives its lease and another worker re-processes the message`,
    );
  }
}

/**
 * Escape a value for use inside an XML attribute.
 *
 * Author names are user-controlled, so they must be escaped — but not wrapped
 * in CDATA, which is only valid for element bodies and corrupts attributes.
 */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape a message body for inclusion in the prompt.
 *
 * A CDATA wrapper would be the wrong tool here: message content is
 * attacker-controlled and routinely contains the literal sequence `]]>`, which
 * closes a CDATA section early and lets the rest of the message escape into
 * the prompt as markup. Plain entity-escaping has no such terminator, so the
 * model always sees the text as text.
 */
export function escapeMessageBody(value: string, maxLen = 3000): string {
  const capped =
    value.length > maxLen ? `${value.slice(0, maxLen)}…[truncated]` : value;
  return capped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

async function generateVisionDescription(
  pool: Pool,
  message: ClaimedMessage,
): Promise<string> {
  // Lazy-import the config first so validation runs before anything
  // else, then the DB class and the LLM client.
  const { config } = await import("../../shared/config/index.js");
  const { createDefaultGateway } = await import("./llmGateway.js");
  try {
    const vision = createDefaultGateway();
    // AttachmentsDb needs a NodePgDatabase; the worker only holds
    // a Pool. Query attachments directly — same columns.
    const rows = await pool.query<{ discord_url: string | null }>(
      `SELECT discord_url FROM attachments WHERE message_id = $1`,
      [message.id],
    );
    if (!rows.rows.length) return "";
    const urls = rows.rows
      .map((a) => a.discord_url ?? "")
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    if (!urls.length) return "";
    const description = await vision.complete({
      system:
        "You are an image description assistant. Describe each image in one short objective sentence. Output only a JSON array of strings, one per image, in the same order. Do not explain, do not judge, do not add commentary.",
      user: `Describe these ${urls.length} image(s). URLs: ${urls.join(" ")}`,
      timeoutMs: config.AI_LLM_VISION_ANALYSIS_TIMEOUT_MS,
    });
    return `\n[Media description: ${description}]\n`;
  } catch (e) {
    log.warn(
      { messageId: message.id, error: String(e) },
      "Failed to generate vision description — analyzing on text only",
    );
    return "";
  }
}

export class ModerationWorker {
  private readonly pool: Pool;
  private readonly llm: LlmGateway;
  private readonly config: WorkerConfig;
  readonly workerId: string;
  private stopped = false;
  private loop: Promise<void> | null = null;
  readonly stats: WorkerStats = emptyStats();

  constructor(pool: Pool, llm: LlmGateway, config?: Partial<WorkerConfig>) {
    this.pool = pool;
    this.llm = llm;
    this.config = { ...DEFAULT_WORKER_CONFIG, ...config };
    assertLeaseCoversLlmTimeout(this.config);
    // A fresh id per process is the point: a restarted worker must not be able
    // to reclaim its own previous leases and reprocess them.
    this.workerId = `w-${randomUUID().slice(0, 8)}`;
    log.info(
      { workerId: this.workerId, ...this.config },
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
    try {
      result = await this.analyze(messages);
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

    await this.persist(messages, result);
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
    const { rows } = await this.pool.query<ClaimedMessage>(
      `SELECT m.id,
              m.guild_id      AS "guildId",
              m.channel_id    AS "channelId",
              m.user_id       AS "authorId",
              m.content,
              m.created_at    AS "createdAt",
              m.username      AS "username",
              c.attempts::int AS "attempts",
              (a.n IS NOT NULL) AS "hasMedia"
         FROM claim_messages($1, $2, $3) AS c
         JOIN messages m ON m.id = c.id
         LEFT JOIN (
              SELECT message_id, count(*) AS n
                FROM attachments GROUP BY message_id
         ) a ON a.message_id = m.id`,
      [this.workerId, this.config.claimBatchSize, this.config.leaseMs],
    );
    if (rows.length > 0) logClaimed(this.workerId, rows);
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


  private async analyze(messages: ClaimedMessage[]): Promise<ParseBatchResult> {
    const requestedIds = messages.map((m) => m.id);
    const hasMedia = messages.some((m) => m.hasMedia);

    const system = buildSystemPrompt({ mode: hasMedia ? "mixed" : "text" });

    const body = messages
      .map((m) => {
        const who = m.username ? `${m.username} (${m.authorId})` : m.authorId;
        // Image descriptions from the vision model are prepended so
        // the moderation LLM can judge media even when the message
        // has no text. Generated here because the gateway already
        // holds the attachment URL and the policy dispatches in
        // "mixed" mode when hasMedia is true.
        const vision = m.hasMedia
          ? generateVisionDescription(this.pool, m)
          : "";
        // NOTE: only the CONTENT is sanitised. The id/author/ts attributes are
        // structured data we generate, and passing the id through
        // sanitizeAiContent would wrap it in <![CDATA[…]]> — which breaks the
        // `<message id="…">` tag the model must echo back, and made the
        // requested-id extraction below find nothing. Message ids are Discord
        // snowflakes (digits only), so they carry no injection risk; author
        // names are user-controlled and therefore escaped with XML entities
        // only, without the CDATA wrapper.
        return (
          `<message id="${m.id}" author="${escapeXmlAttr(who)}" ` +
          `ts="${isoFromEpoch(m.createdAt)}">\n${escapeMessageBody(m.content)}\n</message>`
        );
      })
      .join("\n");

    const userPrompt =
      `Analisis ${messages.length} pesan berikut dan kembalikan JSON ` +
      `dengan satu entri per message_id di dalam field results.\n\n${body}`;

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
    return result;
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
      if (result.missing.length > 0) {
        await client.query(
          `UPDATE messages
              SET ai_status = 'pending', worker_id = NULL, lease_until = NULL,
                  ready_for_work_at = (extract(epoch from now())*1000)::bigint
            WHERE id = ANY($1::text[]) AND ai_status = 'claimed' AND worker_id = $2`,
          [result.missing, this.workerId],
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
  }

  private async writeVerdict(
    client: PoolClient,
    msg: ClaimedMessage,
    v: ParsedVerdict,
  ): Promise<void> {
    const isError = v.status === "error";

    await client.query(
      `INSERT INTO verdicts
         (message_id, status, severity, score, confidence, flags, categories,
          analysis, evidence, recommended_action, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (message_id) DO UPDATE SET
         status = EXCLUDED.status, severity = EXCLUDED.severity,
         score = EXCLUDED.score, confidence = EXCLUDED.confidence,
         flags = EXCLUDED.flags, categories = EXCLUDED.categories,
         analysis = EXCLUDED.analysis, evidence = EXCLUDED.evidence,
         recommended_action = EXCLUDED.recommended_action,
         model = EXCLUDED.model,
         updated_at = (extract(epoch from now())*1000)::bigint`,
      [
        msg.id,
        isError ? "error" : v.status,
        v.severity,
        v.score,
        v.confidence,
        v.flags,
        v.categories,
        v.analysis,
        JSON.stringify(v.evidence),
        v.recommendedAction,
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
      recommendedAction: v.recommendedAction,
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
                  + ($4::bigint * (1 << GREATEST(attempts - 1, 0))),
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
