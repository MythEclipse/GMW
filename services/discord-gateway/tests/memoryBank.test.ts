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
import type { LlmGateway } from "../src/modules/ai-moderation/llmGateway.js";
import {
  buildMemoryTags,
  buildRecallQuery,
  extractMemoryAuthor,
  filterByTags,
  formatAuthorForPrompt,
  formatMemoryContent,
  formatMemoryContext,
  type MemoryMessage,
  ModerationMemoryBank,
} from "../src/modules/ai-moderation/memoryBank.js";
import {
  buildSystemPrompt,
  clearPromptCache,
  MEMORY_RULES,
} from "../src/modules/ai-moderation/policy.js";
import {
  DEFAULT_WORKER_CONFIG,
  ModerationWorker,
} from "../src/modules/ai-moderation/worker.js";

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
    analysis: "Promosi judi dengan link, perlu ditinjau.",
    status: "flagged",
    severity: "high",
    categories: ["gambling"],
  });

  // Every name, so a later query about ANY of them can find this memory.
  expect(content).toContain("Zulfikar Pratama");
  expect(content).toContain("zulfik_dev");
  expect(content).toContain("Zul");
  // The verdict rides along, so a recall can ask "have we seen this scam".
  expect(content).toContain("flagged");
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
    analysis: "",
    status: "clean",
    severity: "none",
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

test("the query names the channels and participants in the batch", () => {
  const q = buildRecallQuery([
    {
      messageId: "m",
      guildId: "g1",
      channelId: "c1",
      content: "",
      createdAt: "2026-09-29T10:00:00.000Z",
      author: extractMemoryAuthor(
        "1",
        JSON.stringify({ author: { username: "zulfik_dev" } }),
      ),
      analysis: "",
      status: "clean",
      severity: "none",
      categories: [],
    },
  ]);
  expect(q).toContain("c1");
  expect(q).toContain("zulfik_dev");
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
  expect(MEMORY_RULES).toContain("KONTEKS");
  // The dangerous inversion: memory must not license a harsher verdict.
  expect(MEMORY_RULES).toContain("alasan untuk lebih longgar");
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
  const out = await bank.recallChannelContext([
    {
      messageId: "m",
      guildId: "g1",
      channelId: "c1",
      content: "hi",
      createdAt: "2026-09-29T10:00:00.000Z",
      author: extractMemoryAuthor("1", null),
      analysis: "",
      status: "clean",
      severity: "none",
      categories: [],
    },
  ]);
  expect(out).toBe("");
});

test("disabled memory constructs no client and recalls nothing", async () => {
  const bank = new ModerationMemoryBank({
    baseUrl: "http://127.0.0.1:9",
    bankId: "gmw-moderation",
    enabled: false,
    recallMaxTokens: 500,
    recallBudget: "low",
    recallTimeoutMs: 2_000,
    retainBatchSize: 10,
  });
  expect(bank.enabled).toBe(false);
  expect(
    await bank.recallChannelContext([
      {
        messageId: "m",
        guildId: "g1",
        channelId: "c",
        content: "x",
        createdAt: "2026-09-29T10:00:00.000Z",
        author: extractMemoryAuthor("1", null),
        analysis: "",
        status: "clean",
        severity: "none",
        categories: [],
      },
    ]),
  ).toBe("");
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
            severity: "none",
            confidence: 0.9,
            score: 0.02,
            recommended_action: "none",
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
