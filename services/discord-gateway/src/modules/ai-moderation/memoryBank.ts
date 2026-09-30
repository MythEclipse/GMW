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
 * Bank `gmw-moderation` on the Hindsight instance at 100.121.180.82:8888. That
 * instance also serves Hermes's own `hermes` bank (250+ facts about this user).
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

import { HindsightClient } from "@vectorize-io/hindsight-client";
import { config } from "@/shared/config/index";
import { createChildLogger } from "@/shared/logger/index";
import {
  escapeMessageBody,
  escapeXmlAttr,
} from "../message-capture/messageMetadata.js";

const log = createChildLogger("ai-moderation/memory");

/**
 * One message's identity and evidence, as captured in `messages.metadata`.
 *
 * Every field is optional because the metadata column is nullable and older
 * rows predate some of these keys.
 */
export type MemoryAuthor = {
  /** Snowflake. Kept for exact match, not for search. */
  userId: string;
  /** Discord's login name, unique account-wide — "budi_dev". */
  username: string | null;
  /** The user's chosen display name — "Budi S." */
  globalName: string | null;
  /** Per-guild display name, i.e. the nickname when one is set. */
  serverName: string | null;
  bot: boolean;
  /** Discord's legacy discriminator, when the account still has one. */
  tag: string | null;
};

export type MemoryMessage = {
  messageId: string;
  guildId: string;
  channelId: string;
  content: string;
  createdAt: string;
  author: MemoryAuthor;
  /** The moderation model's own reading of the message, for the bank. */
  analysis: string;
  status: string;
  severity: string;
  categories: string[];
  mediaDescription?: string;
};

export type MemoryBankConfig = {
  baseUrl: string;
  bankId: string;
  /** Master switch. When false nothing here constructs a client. */
  enabled: boolean;
  /** Token budget for one recall. Small: this is prompt context, not a report. */
  recallMaxTokens: number;
  /** Recall retrieval budget. `low` keeps latency near the measured 0.7s. */
  recallBudget: "low" | "mid" | "high";
  /** Per-call deadline for recall, counted against the moderation call. */
  recallTimeoutMs: number;
  /** Hard cap on retained items per batch. */
  retainBatchSize: number;
};

export const DEFAULT_MEMORY_BANK_CONFIG: MemoryBankConfig = {
  baseUrl: "http://100.121.180.82:8888",
  bankId: "gmw-moderation",
  enabled: true,
  recallMaxTokens: 1200,
  recallBudget: "low",
  recallTimeoutMs: 8_000,
  retainBatchSize: 40,
};

/** Tags applied to every retained item, so recall can scope to a channel. */
export function buildMemoryTags(m: {
  guildId: string;
  channelId: string;
}): string[] {
  return [`channel:${m.channelId}`, `guild:${m.guildId}`];
}

/**
 * The text handed to Hindsight for one message.
 *
 * Prose, not a field dump: the retain step runs an LLM extraction over this,
 * and a terse `user=123 msg=hello` yields a fact with no name in it — which is
 * exactly the useless "user 123 posted X" memory the identity work exists to
 * prevent. Names lead, and the verdict rides along so a later recall can ask
 * "has this guild seen this scam before" without a second lookup.
 */
export function formatMemoryContent(m: MemoryMessage): string {
  const names = [
    m.author.globalName,
    m.author.serverName,
    m.author.username,
  ].filter((n): n is string => Boolean(n && n.trim()));
  const named = names.length > 0 ? names.join(" / ") : m.author.userId;

  const parts: string[] = [
    m.author.bot
      ? `Bot ${named} mengirim pesan di server Discord ${m.guildId}, channel ${m.channelId}.`
      : `Anggota ${named} mengirim pesan di server Discord ${m.guildId}, channel ${m.channelId}.`,
  ];

  const body = m.content.trim();
  parts.push(
    body.length > 0
      ? `Isi pesan: "${body}"`
      : "Pesan tanpa teks (hanya lampiran atau embed).",
  );

  if (m.mediaDescription?.trim()) {
    parts.push(`Deskripsi media: ${m.mediaDescription.trim()}`);
  }

  parts.push(
    `Penilaian moderasi: status=${m.status}, severity=${m.severity}` +
      (m.categories.length > 0 ? `, kategori=${m.categories.join(", ")}` : ""),
  );
  if (m.analysis.trim()) parts.push(`Analisis moderator: ${m.analysis.trim()}`);

  return parts.join(" ");
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
  };
  if (!metadata) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return empty;
  }
  if (typeof parsed !== "object" || parsed === null) return empty;

  const root = parsed as {
    author?: Record<string, unknown>;
    member?: Record<string, unknown> | null;
  };
  const a = root.author ?? {};
  const m = root.member ?? {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

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
  };
}

/** The wire shape of one result row, narrowed to what we consume. */
type RecallRow = {
  text?: string | null;
  type?: string | null;
  tags?: string[] | null;
};

export type ModerationMemory = {
  text: string;
  type: string;
};

/**
 * Thin wrapper over the Hindsight client.
 *
 * Deliberately not a singleton created at import time: config validation is a
 * side effect of importing `@/shared/config`, and tests inject a stub. The
 * worker receives this like the LLM gateway, so nothing here needs a network.
 */
export class ModerationMemoryBank {
  private client: HindsightClient | null = null;

  constructor(
    private readonly cfg: MemoryBankConfig = DEFAULT_MEMORY_BANK_CONFIG,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  private getClient(): HindsightClient {
    if (!this.client) {
      this.client = new HindsightClient({
        baseUrl: this.cfg.baseUrl,
        userAgent: "gmw-moderation-worker/1.0",
        // Recall is idempotent, so the SDK's capacity retry is worth having.
        // Writes are never retried by the SDK, which is correct for a memory
        // write we must not duplicate.
        maxAttempts: 2,
      });
    }
    return this.client;
  }

  /**
   * Fetch what this channel's history already knows.
   *
   * Returns "" on every failure path, including "nothing relevant". The caller
   * interpolates the result straight into the prompt, so an empty string must
   * mean "say nothing", never "say something went wrong".
   */
  async recallChannelContext(messages: MemoryMessage[]): Promise<string> {
    if (!this.cfg.enabled || messages.length === 0) return "";

    // One query per batch, scoped to the channels in it. A batch spans channels
    // (claim_messages does not group), so the tags are the union — and the
    // client-side filter below is what actually keeps them apart.
    const channels = [...new Set(messages.map((m) => m.channelId))];
    const tags = channels.map((c) => `channel:${c}`);

    try {
      const client = this.getClient();
      const response = await withTimeout(
        client.recall(this.cfg.bankId, buildRecallQuery(messages), {
          budget: this.cfg.recallBudget,
          maxTokens: this.cfg.recallMaxTokens,
          tags,
          tagsMatch: "any_strict",
          // Without this, recall returns both the consolidated observation and
          // the raw facts it was built from, and the prompt carries the same
          // sentence twice.
          preferObservations: true,
        }),
        this.cfg.recallTimeoutMs,
      );

      const kept = filterByTags(response.results, tags);
      if (kept.length === 0) return "";

      return formatMemoryContext(kept, channels);
    } catch (e) {
      log.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          channels: channels.length,
          messages: messages.length,
        },
        "hindsight recall failed — analysing without memory context",
      );
      return "";
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
    if (!this.cfg.enabled || messages.length === 0) return;

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
      },
      tags: buildMemoryTags(m),
    }));

    const client = this.getClient();
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
        );
      });
  }

  /** Config from env, with Hindsight off unless explicitly enabled. */
  static fromConfig(): ModerationMemoryBank {
    return new ModerationMemoryBank({
      baseUrl: config.AI_MEMORY_BASE_URL,
      bankId: config.AI_MEMORY_BANK_ID,
      enabled: config.AI_MEMORY_ENABLED,
      recallMaxTokens: config.AI_MEMORY_RECALL_MAX_TOKENS,
      recallBudget: config.AI_MEMORY_RECALL_BUDGET,
      recallTimeoutMs: config.AI_MEMORY_RECALL_TIMEOUT_MS,
      retainBatchSize: config.AI_MEMORY_RETAIN_BATCH_SIZE,
    });
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
  const wanted = new Set(want);
  return results.filter((r) => (r.tags ?? []).some((t) => wanted.has(t)));
}

/**
 * Build the query text from what is actually in the batch.
 *
 * Names and channel ids come from the messages themselves, so a recall about
 * "who says X here" matches the words the model is about to see. A fixed query
 * ("what happened recently?") retrieves generic recent facts instead, which is
 * how a memory bank turns into noise.
 */
export function buildRecallQuery(messages: MemoryMessage[]): string {
  const channels = [...new Set(messages.map((m) => m.channelId))];
  const authors = [
    ...new Set(
      messages
        .flatMap((m) => [
          m.author.globalName,
          m.author.serverName,
          m.author.username,
        ])
        .filter((n): n is string => Boolean(n && n.trim())),
    ),
  ].slice(0, 6);

  return [
    `Riwayat moderasi channel ${channels.slice(0, 3).join(", ")}`,
    authors.length > 0 ? `peserta ${authors.join(", ")}` : null,
    "norma kanal, siapa yang habitually mengirim link judi atau promosi, dan topik apa yang biasa dibahas",
  ]
    .filter((x): x is string => x !== null)
    .join(" — ");
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
    (n): n is string => Boolean(n && n.trim()),
  );
  // The snowflake always closes it, so an id-only author is still
  // distinguishable and never renders as an empty attribute.
  parts.push(author.userId);
  return escapeXmlAttr([...new Set(parts)].join(" | "));
}

/** Render recall rows as the `<memory_context>` block. */
export function formatMemoryContext(
  rows: readonly RecallRow[],
  channels: readonly string[],
): string {
  const body = rows
    .map((r) => {
      const text = (r.text ?? "").trim();
      return text ? `- (${r.type ?? "fact"}) ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  if (!body) return "";

  return `<memory_context bank="gmw-moderation" channels="${escapeXmlAttr(
    channels.join(","),
  )}">\n${body}\n</memory_context>`;
}

/**
 * Reject a call that overruns its budget.
 *
 * `AbortController` alone is not enough: a stall before the request is sent
 * would otherwise keep the worker waiting. Racing a timer bounds it either way.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`hindsight recall exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
