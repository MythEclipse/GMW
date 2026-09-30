/**
 * A channel on the skip list must never be analysed — and must stop being
 * re-offered, not be re-claimed forever.
 *
 * WHY A TERMINAL STATE WAS NEEDED
 *
 * Until now a skip could only be expressed as "release the claim and put the
 * row back", which is what the NSFW path does: `ai_status = 'pending'` with a
 * 5-minute backoff. That is not a skip, it is a poll — the row is re-claimed
 * 12x an hour for the lifetime of the message, `attempts` climbs without
 * bound, the backlog gauge never drains, and if the condition is later removed
 * the row arrives already carrying a nonsense attempt count.
 *
 * There was no way to say "we are never going to analyse this", because the
 * state machine had no terminal state for it. `MessageState` even declared
 * `| "skipped"` in worker.ts while nothing ever wrote it, and
 * `claim_messages()` carried an unused `p_excluded_channel_ids` parameter for
 * the same idea. So a channel that is deliberately exempt (a bot-dedicated
 * channel) had to either poll forever or be dropped at capture time — and
 * capture is the dashboard, so dropping it there hides the channel entirely.
 *
 * `skipped` is that terminal state: no verdict (there is no judgement to make),
 * no retry budget consumed, and never re-claimed.
 *
 * Run: bun test tests/
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import pg from "pg";
import type {
  LlmGateway,
  LlmRequest,
} from "../src/modules/ai-moderation/llmGateway.js";
import { ModerationWorker } from "../src/modules/ai-moderation/worker.js";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:***@127.0.0.1:5433/gmw_mod";

/** The bot-dedicated channel this feature exists for. */
const SKIP_CHANNEL = "1308392257975488593";
/** A single thread inside an otherwise fully moderated channel. */
const SKIP_THREAD = "1305418007345893480";
const NORMAL_CHANNEL = "chan-normal";

let pool: pg.Pool;
let reachable = false;

async function seed(
  rows: { id: string; channel: string; user?: string; thread?: string }[],
): Promise<void> {
  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  for (const r of rows) {
    await pool.query(
      `INSERT INTO messages
         (id, guild_id, channel_id, thread_id, user_id, username, content,
          created_at, ai_status, ready_for_work_at, metadata)
       VALUES ($1, 'g1', $2, $3, $4, 'user', $5, 1, 'pending', 0, NULL)`,
      [r.id, r.channel, r.thread ?? null, r.user ?? "u1", `body ${r.id}`],
    );
  }
}

function scriptedGateway(
  respond: (req: LlmRequest, call: number) => string,
): LlmGateway & { calls: number; seenIds: string[] } {
  const g = {
    modelLabel: "scripted",
    calls: 0,
    seenIds: [] as string[],
    async complete(req: LlmRequest): Promise<string> {
      g.calls += 1;
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      g.seenIds.push(...ids);
      return respond(req, g.calls);
    },
  };
  return g;
}

const verdictFor = (ids: string[]) =>
  JSON.stringify({
    results: ids.map((id) => ({
      message_id: id,
      status: "flagged",
      flags: ["abuse"],
      categories: ["abuse"],
      severity: "high",
      confidence: 0.95,
      score: 0.9,
      recommended_action: "delete",
      analysis: "test verdict",
      evidence: [],
      policy_version: "test",
    })),
  });

/** Small, self-consistent budget — the lease must exceed vision + moderation. */
const TEST_WORKER_CONFIG = {
  claimBatchSize: 10,
  leaseMs: 60_000,
  llmTimeoutMs: 10_000,
  visionTimeoutMs: 10_000,
  idlePollMs: 10,
  skipChannelIds: [SKIP_CHANNEL],
  skipThreadIds: [SKIP_THREAD],
} as const;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  try {
    await pool.query("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await pool?.end();
});

describe("a skipped channel is never analysed", () => {
  test("the database accepts a terminal 'skipped' state", async () => {
    if (!reachable) return;
    // Guards the migration itself. Without 0023 this throws check_violation and
    // every skip path in the worker fails at runtime instead of at boot.
    await seed([{ id: "chk-1", channel: NORMAL_CHANNEL }]);
    await pool.query(
      "UPDATE messages SET ai_status = 'skipped' WHERE id = 'chk-1'",
    );
    const { rows } = await pool.query<{ ai_status: string }>(
      "SELECT ai_status FROM messages WHERE id = 'chk-1'",
    );
    expect(rows[0].ai_status).toBe("skipped");

    // And the v1 vocabulary is still rejected, so the state stays disciplined.
    await expect(
      pool.query(
        "UPDATE messages SET ai_status = 'processing' WHERE id = 'chk-1'",
      ),
    ).rejects.toThrow(/messages_ai_status_check/);
  });

  test("a skipped message is not sent to the model", async () => {
    if (!reachable) return;
    await seed([
      { id: "skip-1", channel: SKIP_CHANNEL },
      { id: "keep-1", channel: NORMAL_CHANNEL },
    ]);

    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    expect(llm.seenIds).not.toContain("skip-1");
    expect(llm.seenIds).toContain("keep-1");
  });

  test("it lands in the terminal 'skipped' state, not back in the queue", async () => {
    if (!reachable) return;
    await seed([{ id: "skip-2", channel: SKIP_CHANNEL }]);
    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    const { rows } = await pool.query<{
      ai_status: string;
      worker_id: string | null;
      lease_until: string | null;
    }>(
      "SELECT ai_status, worker_id, lease_until FROM messages WHERE id = 'skip-2'",
    );
    expect(rows[0].ai_status).toBe("skipped");
    // No claim is held and no lease is outstanding: a skipped row must not be
    // reclaimable, or the next poll re-offers it.
    expect(rows[0].worker_id ?? null).toBeNull();
    expect(rows[0].lease_until ?? null).toBeNull();
  });

  test("it is never re-claimed on a later poll", async () => {
    if (!reachable) return;
    await seed([
      { id: "skip-3", channel: SKIP_CHANNEL },
      { id: "keep-3", channel: NORMAL_CHANNEL },
    ]);
    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);

    await worker.runOnce();
    const callsAfterFirst = llm.calls;
    // Drain everything else, then poll again several times. A re-claim loop
    // would show up as extra calls naming skip-3.
    for (let i = 0; i < 3; i++) {
      await pool.query("UPDATE messages SET ready_for_work_at = 0");
      await worker.runOnce();
    }

    expect(llm.seenIds).not.toContain("skip-3");
    // No LLM call at all after the first pass: the queue is empty, not looping.
    expect(llm.calls).toBe(callsAfterFirst);

    const { rows } = await pool.query<{ ai_status: string }>(
      "SELECT ai_status FROM messages WHERE id = 'skip-3'",
    );
    expect(rows[0].ai_status).toBe("skipped");
  });

  test("skipping consumes no retry budget", async () => {
    if (!reachable) return;
    await seed([{ id: "skip-4", channel: SKIP_CHANNEL }]);
    const worker = new ModerationWorker(
      pool,
      scriptedGateway(() => "never called"),
      TEST_WORKER_CONFIG,
    );

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    // The re-claim loop incremented `attempts` on every pass, so a skipped
    // message carried an ever-growing count and could reach the attempt cap
    // while never having been analysed. One claim, one attempt.
    const { rows } = await pool.query<{ attempts: number; ai_status: string }>(
      "SELECT attempts, ai_status FROM messages WHERE id = 'skip-4'",
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].ai_status).toBe("skipped");
  });

  test("a skipped message gets no verdict row", async () => {
    if (!reachable) return;
    await seed([{ id: "skip-5", channel: SKIP_CHANNEL }]);
    const worker = new ModerationWorker(
      pool,
      scriptedGateway(() => verdictFor(["skip-5"])),
      TEST_WORKER_CONFIG,
    );
    await worker.runOnce();

    // No verdict means the auto-delete enforcer can never select it either, so
    // nothing in a skipped channel is ever deleted.
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM verdicts WHERE message_id = 'skip-5'",
    );
    expect(rows[0].n).toBe(0);
  });

  test("a thread inherits its parent's skip", async () => {
    if (!reachable) return;
    // `messages.channel_id` is the PARENT for a thread (getMessageLocation
    // writes parentId there), so keying the skip on channel_id covers threads
    // under an exempt channel for free — the same rule EXCLUDED_CHANNEL_IDS
    // uses at capture time.
    await seed([
      { id: "thread-skip", channel: SKIP_CHANNEL },
      { id: "thread-keep", channel: NORMAL_CHANNEL },
    ]);
    await pool.query(
      "UPDATE messages SET thread_id = 't-' || id WHERE id LIKE 'thread-%'",
    );

    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    expect(llm.seenIds).not.toContain("thread-skip");
    expect(llm.seenIds).toContain("thread-keep");
  });

  test("an empty skip list skips nothing", async () => {
    if (!reachable) return;
    // The default must be "moderate", not "skip" — a mis-set env var must not
    // silently unmoderate a whole channel.
    await seed([{ id: "noskip-1", channel: SKIP_CHANNEL }]);
    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, {
      ...TEST_WORKER_CONFIG,
      skipChannelIds: [],
      skipThreadIds: [],
    });
    await worker.runOnce();

    expect(llm.seenIds).toContain("noskip-1");
    const { rows } = await pool.query<{ ai_status: string }>(
      "SELECT ai_status FROM messages WHERE id = 'noskip-1'",
    );
    expect(rows[0].ai_status).toBe("analyzed");
  });
});

describe("a single exempt thread inside a moderated channel", () => {
  // This block is the last one before the migration sentinel, which rebuilds
  // `messages_ai_status_check` WITHOUT 'skipped' to simulate a database stuck
  // at 0022. Postgres validates existing rows on that ALTER, so a single row
  // left behind as `skipped` here fails the sentinel with a constraint
  // violation that looks nothing like a migration bug. Leave no rows.
  afterEach(async () => {
    if (!reachable) return;
    await pool.query(
      "TRUNCATE messages, verdicts, analysis_attempts, attachments",
    );
  });

  test("its messages are never analysed", async () => {
    if (!reachable) return;
    // The channel here is NORMAL_CHANNEL — fully moderated — and only the
    // thread is exempt. This is the case the channel list cannot express:
    // `messages.channel_id` holds the parent id, so a thread id added to
    // skipChannelIds matches nothing and the thread stays moderated.
    await seed([
      { id: "thr-in", channel: NORMAL_CHANNEL, thread: SKIP_THREAD },
      { id: "thr-out", channel: NORMAL_CHANNEL, thread: "other-thread" },
      { id: "thr-none", channel: NORMAL_CHANNEL },
    ]);

    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    expect(llm.seenIds).not.toContain("thr-in");
    expect(llm.seenIds).toContain("thr-out");
    expect(llm.seenIds).toContain("thr-none");
  });

  test("it lands in the terminal 'skipped' state, not back in the queue", async () => {
    if (!reachable) return;
    await seed([
      { id: "thr-term", channel: NORMAL_CHANNEL, thread: SKIP_THREAD },
    ]);
    const llm = scriptedGateway(() => "never called");
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    const { rows } = await pool.query<{
      ai_status: string;
      worker_id: string | null;
      lease_until: string | null;
      attempts: number;
    }>(
      `SELECT ai_status, worker_id, lease_until, attempts
         FROM messages WHERE id = 'thr-term'`,
    );
    expect(rows[0].ai_status).toBe("skipped");
    expect(rows[0].worker_id ?? null).toBeNull();
    expect(rows[0].lease_until ?? null).toBeNull();
    // One claim, one attempt — the skip consumes no retry budget.
    expect(rows[0].attempts).toBe(1);
  });

  test("neither list matches the other's column", async () => {
    if (!reachable) return;
    // Guards the reason this list exists, in both directions. A thread id typed
    // into AI_SKIP_ANALYSIS_CHANNEL_IDS must match nothing (it never appears in
    // channel_id), and a channel id typed into AI_SKIP_ANALYSIS_THREAD_IDS
    // must match nothing either (it never appears in thread_id). Crossing the
    // two columns would let a typo exempt a whole channel instead of one
    // thread — far worse than the bug being fixed.
    await seed([
      // Parent exempt, own thread is not on any list → skipped via channel.
      { id: "thr-wrongchan", channel: SKIP_CHANNEL, thread: "t-xyz" },
      // Parent is normal, but thread_id carries the CHANNEL id → still judged.
      { id: "thr-wrongchan2", channel: NORMAL_CHANNEL, thread: SKIP_CHANNEL },
    ]);
    const llm = scriptedGateway((req) => {
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1],
      );
      return verdictFor(ids);
    });
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    const { rows } = await pool.query<{ id: string; ai_status: string }>(
      "SELECT id, ai_status FROM messages WHERE id IN ('thr-wrongchan','thr-wrongchan2')",
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.ai_status]));
    expect(byId["thr-wrongchan"]).toBe("skipped");
    expect(llm.seenIds).not.toContain("thr-wrongchan");
    // thr-wrongchan2's channel is not exempt and its thread_id is not on the
    // thread list, so it is analysed — a channel id in the thread list does
    // not exempt a whole channel.
    expect(byId["thr-wrongchan2"]).toBe("analyzed");
    expect(llm.seenIds).toContain("thr-wrongchan2");
  });

  test("an exempt thread under an exempt channel still lands in skipped", async () => {
    if (!reachable) return;
    // Both lists apply; the channel wins the label because it is the broader
    // rule, and one `skipped` write is all it takes either way.
    await seed([
      { id: "thr-both", channel: SKIP_CHANNEL, thread: SKIP_THREAD },
    ]);
    const llm = scriptedGateway(() => "never called");
    const worker = new ModerationWorker(pool, llm, TEST_WORKER_CONFIG);
    await worker.runOnce();

    const { rows } = await pool.query<{ ai_status: string }>(
      "SELECT ai_status FROM messages WHERE id = 'thr-both'",
    );
    expect(rows[0].ai_status).toBe("skipped");
  });
});

describe("the migration sentinel knows about 0023", () => {
  test("a database stuck at 0022 does not get stamped as at 0023", async () => {
    if (!reachable) return;
    // The reconciler stamps the newest journal migration into
    // __drizzle_migrations as applied WITHOUT running it whenever the schema
    // looks at-latest. That has bitten this repo twice: 0021's backfill and
    // 0022's columns were both silently marked done while the objects were
    // missing. 0023 only relaxes a CHECK constraint, so its sentinel has to
    // name that constraint — otherwise a database stuck at 0022 is stamped as
    // at 0023 and every skip write throws check_violation in production while
    // the gateway reports a healthy boot.
    const { getLastMigrationWhen, seedDrizzleHistory } = await import(
      "../src/shared/database/migrate.ts"
    );
    const when = await getLastMigrationWhen();
    expect(when).toBeGreaterThan(1788086400000); // newer than 0022

    const client = await pool.connect();
    try {
      // Pretend the marker exists (as it would on a DB where a previous boot
      // stamped it) and restore the 0022 constraint, i.e. the exact state that
      // made 0021 and 0022 vanish.
      await client.query(
        `INSERT INTO "__drizzle_migrations" (hash, created_at)
         VALUES ('sentinel-probe', $1) ON CONFLICT DO NOTHING`,
        [when],
      );
      await client.query(
        `ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_status_check`,
      );
      await client.query(
        `ALTER TABLE messages ADD CONSTRAINT messages_ai_status_check
         CHECK (ai_status IN ('pending','claimed','analyzed','retry_wait','dead'))`,
      );

      await seedDrizzleHistory(client);

      // The marker must be gone, so Drizzle applies 0023 for real instead of
      // trusting the stamp.
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int n FROM "__drizzle_migrations" WHERE created_at = $1`,
        [when],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      // Put 0023 back and leave no probe rows behind.
      await client.query(
        `ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_status_check`,
      );
      await client.query(
        `ALTER TABLE messages ADD CONSTRAINT messages_ai_status_check
         CHECK (ai_status IN ('pending','claimed','analyzed','retry_wait','dead','skipped'))`,
      );
      await client.query(
        `DELETE FROM "__drizzle_migrations" WHERE hash = 'sentinel-probe'`,
      );
      client.release();
    }

    // And the restored constraint is the real one, so the suite leaves the dev
    // database in the state 0023 leaves it in.
    const { rows: def } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'messages_ai_status_check'`,
    );
    expect(def[0].def).toContain("skipped");
  });
});
