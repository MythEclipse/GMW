/**
 * Hindsight memory: identity, isolation, and the prompt wiring.
 *
 * Three things are pinned here, and each one corresponds to a way this
 * feature could be silently useless:
 *
 * 1. IDENTITY. A memory keyed on a snowflake is invisible to a semantic query
 *    about a name. `extractMemoryAuthor` + `formatMemoryContent` must carry
 *    the global username AND the server-scoped nickname.
 * 2. ISOLATION. The live instance leaks untagged rows through a strict tag
 *    filter (verified 2026-09-30 on bank `gmw-probe-t6`), so `filterByTags`
 *    is the only thing standing between channel A's history and channel B's
 *    prompt. It is pure, so it is tested without a network.
 * 3. WIRING. A unit test on the formatter passes while the block never reaches
 *    the model — which is exactly how the link-embed bug survived. The last
 *    test below runs a real worker against a real DB and asserts on the
 *    captured prompt string.
 */
import { expect, test } from "bun:test";
import pg from "pg";
import type { LlmGateway } from "../src/modules-gateway/ai-moderation/llmGateway.js";
import {
  buildMemoryTags,
  buildRecallQuery,
  extractMemoryAuthor,
  extractMemoryContext,
  filterByTags,
  formatAuthorForPrompt,
  formatMemoryContent,
  formatMemoryContext,
  type MemoryMessage,
  ModerationMemoryBank,
} from "../src/modules-gateway/ai-moderation/memoryBank.js";
import {
  buildSystemPrompt,
  clearPromptCache,
  HISTORY_RULES,
  MEMORY_RULES,
} from "../src/modules-gateway/ai-moderation/policy.js";
import {
  DEFAULT_WORKER_CONFIG,
  ModerationWorker,
} from "../src/modules-gateway/ai-moderation/worker.js";

/**
 * A minimal valid `MemoryMessage`, so the tests below can state only the field
 * each one is actually about. `context: {}` is the honest default: it is what
 * `extractMemoryContext` returns for a row whose metadata is absent, and the
 * formatters must render that case rather than crash on it.
 */
const baseMessage: MemoryMessage = {
  messageId: "m1",
  guildId: "g1",
  channelId: "c1",
  content: "halo",
  createdAt: "2026-09-29T10:00:00.000Z",
  author: extractMemoryAuthor("1", null),
  context: {},
  analysis: "",
  status: "clean",
  categories: [],
};

// ─── Identity ────────────────────────────────────────────────────────────────

test("identity keeps the global username AND the server nickname", () => {
  const author = extractMemoryAuthor(
    "123456789012345678",
    JSON.stringify({
      author: {
        id: "123456789012345678",
        username: "zulfik_dev",
        globalName: "Zulfikar Pratama",
        tag: "zulfik_dev#0042",
        bot: false,
      },
      member: { nickname: "Zul", displayName: "Zul" },
    }),
  );

  expect(author.userId).toBe("123456789012345678");
  expect(author.username).toBe("zulfik_dev");
  expect(author.globalName).toBe("Zulfikar Pratama");
  // The server-scoped name — the whole point of the user's correction.
  expect(author.serverName).toBe("Zul");
});

test("a missing nickname falls back to the server display name", () => {
  const author = extractMemoryAuthor(
    "999",
    JSON.stringify({
      author: { username: "budi" },
      member: { displayName: "Budi S." },
    }),
  );
  expect(author.serverName).toBe("Budi S.");
});

test("absent metadata yields nulls, never an invented name", () => {
  for (const input of [null, undefined, "", "not json", "[]", "null"]) {
    const author = extractMemoryAuthor("555", input);
    expect(author.username).toBeNull();
    expect(author.globalName).toBeNull();
    expect(author.serverName).toBeNull();
    // The id is still known, and that is enough to store.
    expect(author.userId).toBe("555");
  }
});

// ─── Conversation context ────────────────────────────────────────────────────

test("context comes out of the metadata that capture already wrote", () => {
  const ctx = extractMemoryContext(
    JSON.stringify({
      channel: {
        channelId: "111",
        threadId: "222",
        threadName: "diskusi-app",
        channelName: "general",
        topic: "topik harian server",
        channelType: "GUILD_PUBLIC_THREAD",
      },
      reference: { messageId: "333", channelId: "111" },
    }),
  );
  expect(ctx.threadId).toBe("222");
  expect(ctx.threadName).toBe("diskusi-app");
  expect(ctx.channelName).toBe("general");
  expect(ctx.topic).toBe("topik harian server");
  expect(ctx.channelType).toBe("GUILD_PUBLIC_THREAD");
  expect(ctx.referenceMessageId).toBe("333");
});

test("a root-channel message has a place but no thread", () => {
  const ctx = extractMemoryContext(
    JSON.stringify({ channel: { channelId: "111", channelName: "general" } }),
  );
  expect(ctx.channelName).toBe("general");
  expect(ctx.threadId).toBeNull();
  expect(ctx.threadName).toBeNull();
});

test("missing or unparseable metadata yields an EMPTY context, not a guess", () => {
  for (const input of [null, undefined, "", "not json", "[]", "null", "{}"]) {
    expect(extractMemoryContext(input)).toEqual({});
  }
  // A metadata blob with no channel block must not invent a place.
  expect(
    extractMemoryContext(JSON.stringify({ author: { username: "budi" } })),
  ).toEqual({});
});

test("the retained text leads with WHERE the message was, not just who", () => {
  const content = formatMemoryContent({
    ...baseMessage,
    context: {
      threadId: "222",
      threadName: "diskusi-app",
      channelName: "general",
      topic: "topik harian server",
      channelType: "GUILD_PUBLIC_THREAD",
    },
  });
  // The conversation, in words a recall query can match.
  expect(content).toContain('thread "diskusi-app"');
  expect(content).toContain("#general");
  expect(content).toContain("topik harian server");
  // Ids stay out of the prose: they are in the tags and metadata instead.
  expect(content).not.toContain("222");
});

test("a message with no captured context still renders, without a place", () => {
  const content = formatMemoryContent({ ...baseMessage, context: {} });
  expect(content).toContain("halo");
  expect(content).toContain("channel tanpa nama");
  // Never an empty "di  pada " — the connective is always satisfied.
  expect(content).not.toContain("di  ");
});

test("a thread gets its own tag so a channel recall is not a thread mix", () => {
  expect(
    buildMemoryTags({
      guildId: "g1",
      channelId: "111",
      context: { threadId: "222" },
    }),
  ).toEqual(["channel:111", "guild:g1", "thread:222"]);
  // A root message has no thread tag — and must not be given a fake one, or a
  // channel-scoped recall would silently drop every root message in it.
  expect(
    buildMemoryTags({ guildId: "g1", channelId: "111", context: {} }),
  ).toEqual(["channel:111", "guild:g1"]);
});

test("the query asks about the DISCUSSION, not about who does what", () => {
  const q = buildRecallQuery([
    {
      ...baseMessage,
      context: {
        threadId: "222",
        threadName: "diskusi-app",
        channelName: "general",
        topic: "topik harian server",
      },
      author: extractMemoryAuthor(
        "1",
        JSON.stringify({ author: { username: "zulfik_dev" } }),
      ),
    },
  ]);
  // Place leads, by NAME — the only terms the retained prose carries.
  expect(q).toContain('thread "diskusi-app"');
  expect(q).toContain("#general");
  expect(q).toContain("topik harian server");
  expect(q).toContain("zulfik_dev");
  // The old query asked who habitually sends gambling links, which is what
  // made the bank a behaviour log. That clause must not come back.
  expect(q).not.toContain("habitually");
  expect(q).not.toContain("link judi");
  // Ids are scoped by tags, not smuggled into a semantic query.
  expect(q).not.toContain("222");
});

test("the retained text carries names, not just the id", () => {
  const content = formatMemoryContent({
    messageId: "m1",
    guildId: "g1",
    channelId: "c1",
    content: "kirim link jackpot ZEUS sekarang",
    createdAt: "2026-09-29T10:00:00.000Z",
    author: extractMemoryAuthor(
      "123456789012345678",
      JSON.stringify({
        author: { username: "zulfik_dev", globalName: "Zulfikar Pratama" },
        member: { nickname: "Zul" },
      }),
    ),
    context: {},
    analysis: "Promosi judi dengan link.",
    status: "deleted",
    categories: ["gambling"],
  });

  // Every name, so a later query about ANY of them can find this memory.
  expect(content).toContain("Zulfikar Pratama");
  expect(content).toContain("zulfik_dev");
  expect(content).toContain("Zul");
  // The verdict rides along, so a recall can ask "have we seen this scam".
  // `status` is the only judgement stored now — there is no severity tier and
  // no recommended action to record alongside it.
  expect(content).toContain("deleted");
  expect(content).toContain("gambling");
  expect(content).toContain("kirim link jackpot ZEUS sekarang");
});

test("an id-only author still produces a storable memory", () => {
  const content = formatMemoryContent({
    messageId: "m2",
    guildId: "g1",
    channelId: "c1",
    content: "halo",
    createdAt: "2026-09-29T10:00:00.000Z",
    author: extractMemoryAuthor("777", null),
    context: {},
    analysis: "",
    status: "clean",
    categories: [],
  });
  expect(content).toContain("777");
});

test("the prompt author attribute carries every name as the join key", () => {
  const who = formatAuthorForPrompt({
    userId: "123",
    username: "zulfik_dev",
    globalName: "Zulfikar Pratama",
    serverName: "Zul",
    bot: false,
    tag: null,
  });
  // A recall says "Zulfikar"; the message says "zulfik_dev". The model can
  // only connect them if both are present.
  expect(who).toContain("zulfik_dev");
  expect(who).toContain("Zulfikar Pratama");
  expect(who).toContain("Zul");
  expect(who).toContain("123");
});

test("a display name cannot break out of the attribute", () => {
  const who = formatAuthorForPrompt({
    userId: "1",
    username: 'evil" onload="alert(1)',
    globalName: null,
    serverName: null,
    bot: false,
    tag: null,
  });
  expect(who).not.toContain('" onload');
  expect(who).toContain("&quot;");
});

// ─── Isolation ───────────────────────────────────────────────────────────────

test("recall rows without our tag are dropped (the live leak)", () => {
  const rows = [
    { text: "about channel AAA", type: "world", tags: ["channel:AAA"] },
    // Exactly what the instance returned for a strict channel:AAA filter:
    // an observation whose own tags array is EMPTY.
    { text: "about channel BEE", type: "observation", tags: [] },
    { text: "no tags at all", type: "world", tags: null },
    { text: "guild only", type: "world", tags: ["guild:G1"] },
  ];
  const kept = filterByTags(rows, ["channel:AAA"]);
  expect(kept).toHaveLength(1);
  expect(kept[0].text).toContain("AAA");
});

test("a batch spanning two channels keeps both sets", () => {
  const rows = [
    { text: "a", type: "world", tags: ["channel:AAA"] },
    { text: "b", type: "world", tags: ["channel:BBB"] },
    { text: "c", type: "world", tags: [] },
  ];
  const kept = filterByTags(rows, ["channel:AAA", "channel:BBB"]);
  expect(kept.map((r) => r.text)).toEqual(["a", "b"]);
});

test("tags are channel and guild scoped", () => {
  expect(buildMemoryTags({ guildId: "g1", channelId: "c1" })).toEqual([
    "channel:c1",
    "guild:g1",
  ]);
});

// ─── Prompt shape ────────────────────────────────────────────────────────────

test("the memory block is a labelled, closed region", () => {
  const block = formatMemoryContext(
    [
      { text: "Zul sering kirim link judi", type: "observation", tags: [] },
      { text: "  ", type: "world", tags: [] },
    ],
    ["c1", "c2"],
  );
  expect(block).toContain("<memory_context");
  expect(block).toContain("</memory_context>");
  expect(block).toContain("Zul sering kirim link judi");
  // The blank row is dropped rather than rendered as an empty bullet.
  expect(block).not.toContain("- (world)");
});

test("an empty recall renders nothing at all", () => {
  expect(formatMemoryContext([], ["c1"])).toBe("");
  expect(formatMemoryContext([{ text: "  ", tags: [] }], ["c1"])).toBe("");
});

test("the query names the place and the participants, by NAME not by id", () => {
  const q = buildRecallQuery([
    {
      ...baseMessage,
      context: { channelName: "general", topic: "topik harian server" },
      author: extractMemoryAuthor(
        "1",
        JSON.stringify({ author: { username: "zulfik_dev" } }),
      ),
    },
  ]);
  expect(q).toContain("#general");
  expect(q).toContain("topik harian server");
  expect(q).toContain("zulfik_dev");
  // The channel id scopes the recall through tags, not through the query text
  // — a snowflake in a semantic query only adds noise.
  expect(q).not.toContain("c1");
});

test("a batch spanning threads and channels names each place once", () => {
  const q = buildRecallQuery([
    {
      ...baseMessage,
      context: { threadName: "diskusi-app", channelName: "general" },
    },
    { ...baseMessage, messageId: "m2", context: { threadName: "diskusi-app" } },
    { ...baseMessage, messageId: "m3", context: { channelName: "random" } },
  ]);
  expect(q).toContain('thread "diskusi-app"');
  // #random is a genuinely different channel, so the batch really does span
  // two and both belong in the query.
  expect(q).toContain("#general");
  expect(q).toContain("#random");
  // Dedup, not repetition: "diskusi-app" and "general" each appear in
  // messages 1 and 2, and neither is named twice.
  expect(q.match(/"diskusi-app"/g)?.length ?? 0).toBe(1);
  expect(q.match(/#general/g)?.length ?? 0).toBe(1);
});

test("a place-less batch never falls back to asking about PEOPLE", () => {
  const q = buildRecallQuery([
    {
      ...baseMessage,
      author: extractMemoryAuthor(
        "1",
        JSON.stringify({ author: { username: "zulfik_dev" } }),
      ),
    },
  ]);
  // No metadata was ever captured for this row, so there is no place to ask
  // about. The old code opened with the participant list, which is exactly
  // the "who is this person" query that made this bank a behaviour log.
  expect(q).toContain("Riwayat pesan dan penilaian moderasi di kanal ini");
  expect(q).not.toContain("zulfik_dev");
  expect(q).toContain("termasuk topik");
});

test("the system prompt explains memory ONLY when a block is present", () => {
  clearPromptCache();
  const without = buildSystemPrompt({ mode: "text" });
  const with_ = buildSystemPrompt({ mode: "text", memory: true });

  expect(without).not.toContain("MEMORI KANAL");
  expect(with_).toContain("MEMORI KANAL");
  // In the cache key, not merely appended: a cached memory-less prompt served
  // to a memory-carrying batch is the failure this guards.
  expect(without).not.toBe(with_);
  expect(MEMORY_RULES).toContain("<memory_context>");
});

test("the rules tell the model memory is context, not evidence", () => {
  // Normalised: the rule's wording is what is under test, not the line
  // wrapping. A rewrap of the policy text must not read as a regression.
  const rules = MEMORY_RULES.replace(/\s+/g, " ");
  expect(rules).toContain("KONTEKS");
  // The dangerous inversion: memory must not license a harsher verdict.
  expect(rules).toContain("alasan untuk lebih longgar, bukan lebih curiga");
  // Memory is scoped to a place, and a memory from elsewhere is not evidence
  // about this message — the whole point of the 2026-10-01 rebuild.
  expect(rules).toContain("thread atau channel yang berbeda");
  expect(rules).toContain("tempat LAIN");
});

test("the history rules forbid judging the context block", () => {
  const rules = HISTORY_RULES.replace(/\s+/g, " ");
  expect(rules).toContain("KONTEKS");
  // Returning a verdict for a history row would re-apply a decision to a
  // message that was already judged, or delete it twice.
  expect(rules).toContain(
    "JANGAN kembalikan entri results untuk pesan di <conversation_history>",
  );
  expect(rules).toContain("Hanya pesan di blok utama yang dinilai");
});

test("history rules appear only when the prompt carries a history block", () => {
  clearPromptCache();
  const withHistory = buildSystemPrompt({ mode: "text", history: true });
  const without = buildSystemPrompt({ mode: "text", history: false });
  expect(withHistory).toContain("RIWAYAT PERCAKAPAN");
  expect(without).not.toContain("RIWAYAT PERCAKAPAN");
  // And it must not be served from the memory-only cache entry: describing a
  // block that is absent is worse than omitting the rule.
  expect(without).toBe(
    buildSystemPrompt({ mode: "text", memory: false, history: false }),
  );
});

// ─── Failure policy ──────────────────────────────────────────────────────────

test("a dead instance yields no context and never throws", async () => {
  const bank = new ModerationMemoryBank({
    baseUrl: "http://127.0.0.1:9", // discard port: refuses instantly
    bankId: "gmw-moderation",
    enabled: true,
    recallMaxTokens: 500,
    recallBudget: "low",
    recallTimeoutMs: 2_000,
    retainBatchSize: 10,
  });
  const out = await bank.recallChannelContext([baseMessage]);
  expect(out).toBe("");
});

test("a recall that overruns its deadline ABORTS the request", async () => {
  // The production bug this guards: for 8h41m one worker process logged 296
  // deadline failures while the server kept working on them. Racing a timer
  // stops the WAITING, not the request — so the request has to be cancelled,
  // or it runs on into a pool nobody is waiting for. The assertion is on the
  // signal, because "did the server finish" is not observable from here.
  let seenSignal: AbortSignal | undefined;
  // The client resolves `globalThis.fetch` at call time, so the signal it hands
  // to fetch is observable by wrapping the global. `req.signal` on the server
  // side is NOT a valid observation: Bun does not surface a client-initiated
  // abort there, which is exactly the kind of assertion that passes for the
  // wrong reason.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // The SDK builds a `Request` and calls fetch with it as the sole argument,
    // so the signal is on `input` — not in `init`.
    const req = input instanceof Request ? input : new Request(input, init);
    seenSignal = req.signal;
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  let releaseFetch: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      // Held open until the test lets go, so a request that is never cancelled
      // is still pending here when the assertion runs.
      await new Promise<void>((r) => {
        releaseFetch = r;
      });
      return new Response("{}");
    },
  });
  const started = Date.now();
  try {
    const bank = new ModerationMemoryBank({
      baseUrl: `http://127.0.0.1:${server.port}`,
      bankId: "gmw-moderation",
      enabled: true,
      recallMaxTokens: 500,
      recallBudget: "low",
      recallTimeoutMs: 200,
      retainBatchSize: 10,
    });
    expect(await bank.recallChannelContext([baseMessage])).toBe("");
    // The deadline was honoured: rejected at ~200ms, not after a default fetch
    // timeout, and not after the server's own wait.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(5_000);

    // The signal must exist AND already be aborted at the deadline — that is the
    // difference between "gave up waiting" and "actually cancelled it".
    expect(seenSignal).toBeDefined();
    expect(seenSignal?.aborted).toBe(true);
  } finally {
    releaseFetch?.();
    server.stop(true);
    globalThis.fetch = realFetch;
  }
});

test("an unreachable instance recalls nothing instead of throwing", async () => {
  // Memory is always on now, so an unreachable instance is the ONLY failure
  // mode left to prove: recall must degrade to "" and never reject, because a
  // thrown promise here fails the whole moderation batch.
  const bank = new ModerationMemoryBank({
    baseUrl: "http://127.0.0.1:9",
    bankId: "gmw-moderation",
    recallMaxTokens: 500,
    recallBudget: "low",
    recallTimeoutMs: 2_000,
    retainBatchSize: 10,
  });
  expect(await bank.recallChannelContext([baseMessage])).toBe("");
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:***@127.0.0.1:5433/gmw_mod";

/** A memory bank stub: no network, records what the worker asked it to store. */
class StubBank {
  readonly retained: MemoryMessage[] = [];
  readonly recalled: MemoryMessage[][] = [];
  constructor(private readonly context: string) {}
  get enabled(): boolean {
    return true;
  }
  async recallChannelContext(m: MemoryMessage[]): Promise<string> {
    this.recalled.push(m);
    return this.context;
  }
  retainBatch(m: MemoryMessage[]): void {
    this.retained.push(...m);
  }
}

test("the prompt carries the recalled memory AND the author names", async () => {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    return expect(true).toBe(true);
  }

  const CONTEXT =
    '<memory_context bank="gmw-moderation" channels="c1">\n' +
    "- (observation) Zul sering mengirim link judi\n</memory_context>";

  let seenSystem = "";
  let seenUser = "";
  const gateway: LlmGateway = {
    modelLabel: "scripted",
    async complete(req) {
      seenSystem = req.system;
      seenUser = req.user;
      const id = /<message id="([^"]+)"/.exec(req.user)?.[1] ?? "";
      return JSON.stringify({
        results: [
          {
            message_id: id,
            status: "clean",
            flags: [],
            categories: [],
            confidence: 0.9,
            score: 0.02,
            analysis: "Ringkasan isi pesan.",
            evidence: [],
          },
        ],
      });
    },
  };

  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  const MESSAGE_ID = "1554472364094521396";
  await pool.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ($1,'g1','c1','123456789012345678','zulfik_dev',$2,$3,'pending',0,$4)`,
    [
      MESSAGE_ID,
      "bossudin masuk jackpot ZEUS lagi",
      Date.now(),
      JSON.stringify({
        author: {
          id: "123456789012345678",
          username: "zulfik_dev",
          globalName: "Zulfikar Pratama",
        },
        member: { nickname: "Zul", displayName: "Zul" },
        channel: { channelId: "c1", channelName: "umum", nsfw: false },
      }),
    ],
  );

  const bank = new StubBank(CONTEXT);
  const worker = new ModerationWorker(
    pool,
    gateway,
    {
      ...DEFAULT_WORKER_CONFIG,
      leaseMs: 60_000,
      llmTimeoutMs: 10_000,
      visionTimeoutMs: 10_000,
      idlePollMs: 10,
      claimBatchSize: 10,
    },
    undefined,
    bank as unknown as ModerationMemoryBank,
  );
  await worker.runOnce();

  // 1. The memory block reached the prompt…
  expect(seenUser).toContain("<memory_context");
  expect(seenUser).toContain("Zul sering mengirim link judi");
  // …and the system prompt explains how to read it.
  expect(seenSystem).toContain("MEMORI KANAL");

  // 2. The message carries every name, so the memory can be tied to it.
  expect(seenUser).toContain("zulfik_dev");
  expect(seenUser).toContain("Zulfikar Pratama");
  expect(seenUser).toContain("Zul");

  // 3. The judged message was stored, with the verdict attached.
  expect(bank.retained).toHaveLength(1);
  const stored = bank.retained[0];
  expect(stored.messageId).toBe(MESSAGE_ID);
  expect(stored.status).toBe("clean");
  expect(stored.analysis).toBe("Ringkasan isi pesan.");
  expect(stored.author.username).toBe("zulfik_dev");
  expect(stored.author.globalName).toBe("Zulfikar Pratama");
  expect(stored.author.serverName).toBe("Zul");
  // An ISO timestamp, not the raw bigint.
  expect(stored.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  await pool.end();
});

test("the image description reaches the memory bank, not just the prompt", async () => {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    return expect(true).toBe(true);
  }

  // Two gateways: the vision model that describes the image, and the text
  // model that judges it. The description must survive BOTH uses — the
  // moderation prompt and the long-term memory write.
  const vision: LlmGateway = {
    modelLabel: "vision-scripted",
    async complete() {
      return "seorang pria memegang kartu joker";
    },
  };
  const gateway: LlmGateway = {
    modelLabel: "scripted",
    async complete(req) {
      const id = /<message id="([^"]+)"/.exec(req.user)?.[1] ?? "";
      return JSON.stringify({
        results: [
          {
            message_id: id,
            status: "clean",
            flags: [],
            categories: [],
            severity: "none",
            confidence: 0.9,
            score: 0.02,
            recommended_action: "none",
            analysis: "Gambar kartu.",
            evidence: [],
          },
        ],
      });
    },
  };

  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  const MESSAGE_ID = "1554472364094522999";
  await pool.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ($1,'g1','c1','u1','budi','lihat ini',$2,'pending',0,$3)`,
    [
      MESSAGE_ID,
      Date.now(),
      JSON.stringify({
        author: { id: "u1", username: "budi" },
        channel: { channelId: "c1", channelName: "umum", nsfw: false },
      }),
    ],
  );
  // The attachment is what makes claim_messages report hasMedia, and what the
  // vision pass reads to build its description.
  await pool.query(
    `INSERT INTO attachments
       (id, message_id, guild_id, channel_id, user_id, filename, size,
        type, discord_url, created_at)
     VALUES ('a1',$1,'g1','c1','u1','kartu.png',1024,'image/png',$2,$3)`,
    [MESSAGE_ID, "https://cdn.discordapp.com/attachments/1/x.png", Date.now()],
  );

  const bank = new StubBank("");
  const worker = new ModerationWorker(
    pool,
    gateway,
    {
      ...DEFAULT_WORKER_CONFIG,
      leaseMs: 60_000,
      llmTimeoutMs: 10_000,
      visionTimeoutMs: 10_000,
      idlePollMs: 10,
      claimBatchSize: 10,
    },
    vision,
    bank as unknown as ModerationMemoryBank,
  );
  await worker.runOnce();

  // Regression: the vision map is built inside analyze() and used for the
  // prompt, but persist() previously received a FRESH EMPTY map. The prompt
  // got the description and the memory bank silently did not, so a later
  // recall could never mention what any image showed.
  expect(bank.retained).toHaveLength(1);
  expect(bank.retained[0].mediaDescription).toContain(
    "seorang pria memegang kartu joker",
  );

  await pool.end();
});

test("with no bank wired, the prompt is exactly what it was before", async () => {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  try {
    await pool.query("SELECT 1");
  } catch {
    await pool.end();
    return expect(true).toBe(true);
  }

  let seenUser = "";
  const gateway: LlmGateway = {
    modelLabel: "scripted",
    async complete(req) {
      seenUser = req.user;
      const id = /<message id="([^"]+)"/.exec(req.user)?.[1] ?? "";
      return JSON.stringify({
        results: [
          {
            message_id: id,
            status: "clean",
            flags: [],
            categories: [],
            severity: "none",
            confidence: 0.9,
            score: 0.02,
            recommended_action: "none",
            analysis: "Ringkasan.",
            evidence: [],
          },
        ],
      });
    },
  };

  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  await pool.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ('1554472364094521999','g1','c1','u1','budi','halo',$1,'pending',0,NULL)`,
    [Date.now()],
  );

  // No memory bank argument at all — the pre-existing 4-arg call shape.
  const worker = new ModerationWorker(pool, gateway, {
    ...DEFAULT_WORKER_CONFIG,
    leaseMs: 60_000,
    llmTimeoutMs: 10_000,
    visionTimeoutMs: 10_000,
    idlePollMs: 10,
    claimBatchSize: 10,
  });
  await worker.runOnce();

  expect(seenUser).not.toContain("<memory_context");
  // The author still renders, just in the pre-memory shape.
  expect(seenUser).toContain("u1");

  await pool.end();
});
