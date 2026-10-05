/**
 * End-to-end proof: a real worker, a real database, the real channel id.
 *
 * The unit suite drives ModerationWorker with a scripted gateway. This drives
 * it against a stub LLM over a throwaway database and the actual production
 * config wiring, so the whole path is exercised together:
 *
 *   AI_SKIP_ANALYSIS_CHANNEL_IDS -> config -> worker -> ai_status='skipped'
 *
 * and proves the two properties that only matter in production:
 *   1. a message in the exempt channel is never sent to the model;
 *   2. it is terminal — later polls claim nothing, and a message that IS
 *      analysed still goes all the way to a verdict.
 *
 * Run: TEST_DATABASE_URL=postgres://... bun tests/skip-channel-e2e.mjs
 *       (or without the env var, against the dev database at :5433/gmw_mod)
 */
import { randomUUID } from "node:crypto";

const CHANNEL = "1308392257975488593";
const NORMAL = "9999999999999999999";
const DSN =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/gmw_mod";

const { default: pg } = await import("pg");
const { ModerationWorker } = await import(
  "../src/modules-gateway/ai-moderation/worker.ts"
);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const pool = new pg.Pool({ connectionString: DSN, max: 2 });

/** A stub LLM: records every id it was asked about, always answers clean. */
const seen = [];
const llm = {
  modelLabel: "stub",
  async complete(req) {
    const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    seen.push(...ids);
    return JSON.stringify({
      results: ids.map((id) => ({
        message_id: id,
        status: "clean",
        flags: [],
        categories: [],
        confidence: 0.9,
        score: 0.05,
        analysis: "aman",
        evidence: [],
        policy_version: "e2e",
      })),
    });
  },
};

const worker = new ModerationWorker(pool, llm, {
  claimBatchSize: 20,
  leaseMs: 60_000,
  llmTimeoutMs: 10_000,
  visionTimeoutMs: 10_000,
  idlePollMs: 10,
  // Exactly what moderation-worker.ts passes in production.
  skipChannelIds: [CHANNEL],
});

const tag = randomUUID().slice(0, 6);
const SKIP_ID = `e2e-skip-${tag}`;
const KEEP_ID = `e2e-keep-${tag}`;

try {
  await pool.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ($1,'g1',$2,'u1','u','bot command output',1,'pending',0,NULL),
            ($3,'g1',$4,'u1','u','halo dunia',2,'pending',0,NULL)`,
    [SKIP_ID, CHANNEL, KEEP_ID, NORMAL],
  );

  await worker.runOnce();

  // 1. The exempt channel never reached the model.
  check(
    "exempt channel is not sent to the model",
    !seen.includes(SKIP_ID),
    `asked about: ${JSON.stringify(seen)}`,
  );
  check(
    "the normal channel IS still analysed",
    seen.includes(KEEP_ID),
    `asked about: ${JSON.stringify(seen)}`,
  );

  // 2. It reached the terminal state, holding no claim.
  const { rows } = await pool.query(
    `SELECT ai_status, worker_id, lease_until, attempts
       FROM messages WHERE id = $1`,
    [SKIP_ID],
  );
  check("exempt message is 'skipped'", rows[0].ai_status === "skipped", rows[0].ai_status);
  check("no claim held", rows[0].worker_id === null);
  check("no lease outstanding", rows[0].lease_until === null);
  check("no retry budget burned", Number(rows[0].attempts) === 1, `attempts=${rows[0].attempts}`);

  // 3. No verdict, so the auto-delete enforcer can never select it.
  const v = await pool.query(
    "SELECT count(*)::int n FROM verdicts WHERE message_id = $1",
    [SKIP_ID],
  );
  check("no verdict row for the exempt message", v.rows[0].n === 0);

  // 4. Terminal: the queue drains and stays drained. This is what a poll-based
  //    skip cannot do — it would re-ofer the row on every pass.
  const before = seen.length;
  for (let i = 0; i < 5; i++) {
    await pool.query("UPDATE messages SET ready_for_work_at = 0");
    const didWork = await worker.runOnce();
    check(`poll ${i + 1} finds no work`, didWork === false);
  }
  check(
    "no further model calls after the first pass",
    seen.length === before,
    `calls went ${before} -> ${seen.length}`,
  );

  // 5. The control message reached a real verdict, so the skip did not break
  //    the normal path.
  const k = await pool.query(
    `SELECT m.ai_status, v.status AS verdict
       FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
      WHERE m.id = $1`,
    [KEEP_ID],
  );
  check(
    "the normal message is analyzed with a verdict",
    k.rows[0].ai_status === "analyzed" && k.rows[0].verdict === "clean",
    `ai_status=${k.rows[0].ai_status} verdict=${k.rows[0].verdict}`,
  );
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.stack ?? e.message}`);
} finally {
  await pool.query("DELETE FROM messages WHERE id = ANY($1)", [[SKIP_ID, KEEP_ID]]);
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
