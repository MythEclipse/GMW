/**
 * End-to-end proof of the moderation pipeline against a REAL database.
 *
 * The unit tests inject a scripted gateway and assert transitions. This drives
 * the whole path — capture-shaped rows → claim → prompt → parse → verdict →
 * state transition — and asserts the properties that matter operationally:
 * nothing is lost, nothing is judged twice, and no message is stranded.
 *
 * Run:  node tests/pipeline-e2e.mjs      (needs scripts/dev-pg.sh start)
 */
import pg from "pg";
import { ModerationWorker } from "../src/modules/ai-moderation/worker.ts";

const DB =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/gmw_mod";

const pool = new pg.Pool({ connectionString: DB, max: 6 });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function seed(n, { prefix = "e-", attachments = 0 } = {}) {
  await pool.query("TRUNCATE messages, verdicts, analysis_attempts, attachments");
  await pool.query(
    `INSERT INTO messages (id,guild_id,channel_id,user_id,username,content,created_at,ai_status,ready_for_work_at)
     SELECT $2||g,'g1','c1','u'||(g%3),'user'||(g%3),'discord message '||g, g*1000,'pending',0
       FROM generate_series(1,$1) g`,
    [n, prefix],
  );
  if (attachments > 0) {
    await pool.query(
      `INSERT INTO attachments (id, message_id, guild_id, channel_id, filename, upload_status, created_at)
       SELECT $1||g, $2||g, 'g1', 'c1', 'img.png', 'completed', g
         FROM generate_series(1,$3) g`,
      ["att-", prefix, attachments],
    );
  }
}

async function states(prefix) {
  const { rows } = await pool.query(
    "SELECT ai_status, count(*)::int n FROM messages WHERE id LIKE $1 GROUP BY 1",
    [`${prefix}%`],
  );
  return Object.fromEntries(rows.map((r) => [r.ai_status, r.n]));
}

const cfg = {
  leaseMs: 60_000,
  llmTimeoutMs: 10_000,
  idlePollMs: 10,
  claimBatchSize: 25,
  maxAttempts: 5,
};

/**
 * A realistic responder: one message flagged by POSITION, not by an id
 * substring (seeded ids are e-1..e-N and never contain a marker, so an
 * id-based flag silently matches nothing).
 *
 * `mutate` runs on the FIRST call only — a mutation that drops entries would
 * otherwise also fire on the follow-up call and starve the queue forever.
 */
function responder(mutate) {
  return {
    modelLabel: "test-model",
    calls: 0,
    async complete(req) {
      this.calls += 1;
      const first = this.calls === 1;
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map((m) => m[1]);
      const results = ids.map((id, i) => ({
        message_id: id,
        status: i === 7 ? "flagged" : "clean",
        flags: i === 7 ? ["harassment"] : [],
        analysis:
          i === 7
            ? "Pesan mengandung hinaan langsung terhadap pengguna lain."
            : "Tidak ada indikasi pelanggaran.",
        score: i === 7 ? 0.92 : 0.03,
        confidence: i === 7 ? 0.94 : 0.91,
        recommended_action: i === 7 ? "delete" : "none",
        severity: i === 7 ? "high" : "none",
        evidence: i === 7 ? ["kamu dolo"] : [],
      }));
      if (first) mutate?.(results, req);
      return JSON.stringify({ results });
    },
  };
}

// ── 1. Full pipeline, mixed batch ──────────────────────────────────────────
console.log("\n[1] end-to-end: 24 messages, one flagged, one deferred, two omitted");
await seed(24);
const gw = responder((results) => {
  results[3].analysis = "perlu ditinjau oleh moderator sebelum dapat dipastikan";
  results.pop();
  results.pop();
});
const w = new ModerationWorker(pool, gw, cfg);
await w.runOnce();
await w.runOnce();

const s1 = await states("e-");
// Two runOnce() calls: the second drains the two omissions that the first
// requeued. So all 24 are judged — the point is that the omissions were
// requeued rather than marked clean, which the single-pass worker test asserts.
check("no message stranded in claimed", (s1.claimed ?? 0) === 0, JSON.stringify(s1));
check("all 24 reached a verdict after the queue drained", s1.analyzed === 24, JSON.stringify(s1));

const { rows: v } = await pool.query(
  "SELECT status, recommended_action, count(*)::int n FROM verdicts GROUP BY 1,2",
);
const tally = Object.fromEntries(v.map((r) => [`${r.status}/${r.recommended_action}`, r.n]));
check("the flagged message kept its verdict", tally["flagged/delete"] === 1, JSON.stringify(tally));
check("the deferral became a per-message error", tally["error/review"] === 1, JSON.stringify(tally));
check("clean verdicts persisted", tally["clean/none"] === 22, JSON.stringify(tally));

// ── 2. The attempt log explains the work ───────────────────────────────────
console.log("\n[2] append-only attempt log accounts for the work");
const { rows: a } = await pool.query(
  "SELECT outcome, count(*)::int n FROM analysis_attempts GROUP BY 1",
);
const outcomes = Object.fromEntries(a.map((r) => [r.outcome, r.n]));
check("successes logged", (outcomes.success ?? 0) === 23, JSON.stringify(outcomes));
check("the deferral logged as parse_error", (outcomes.parse_error ?? 0) === 1, JSON.stringify(outcomes));

// ── 3. Media detection reads the attachments table ─────────────────────────
console.log("\n[3] media detected from attachments, not from message text");
await seed(3, { prefix: "m-", attachments: 1 });
let withMedia = null;
const gwMedia = responder();
const innerMedia = gwMedia.complete.bind(gwMedia);
gwMedia.complete = async (req) => {
  withMedia = req.system.includes("ANALISIS MEDIA");
  return innerMedia(req);
};
await new ModerationWorker(pool, gwMedia, cfg).runOnce();
check("a message WITH an attachment used the media prompt", withMedia === true, String(withMedia));

await seed(3, { prefix: "n-", attachments: 0 });
let withoutMedia = null;
const gwText = responder();
const innerText = gwText.complete.bind(gwText);
gwText.complete = async (req) => {
  withoutMedia = req.system.includes("ANALISIS MEDIA");
  return innerText(req);
};
await new ModerationWorker(pool, gwText, cfg).runOnce();
check("a text-only message used the text prompt", withoutMedia === false, String(withoutMedia));

// ── 4. Crash mid-flight loses nothing ──────────────────────────────────────
console.log("\n[4] a worker killed mid-flight loses nothing");
await seed(8, { prefix: "r-" });
const dead = new ModerationWorker(pool, responder(), cfg);
await pool.query("SELECT id FROM claim_messages($1,8,$2)", [dead.workerId, 60_000]);
check("dead worker holds all 8", (await states("r-")).claimed === 8, JSON.stringify(await states("r-")));

await pool.query(
  "UPDATE messages SET lease_until = (extract(epoch from now())*1000)::bigint - 1 WHERE worker_id=$1",
  [dead.workerId],
);
const { rows: rec } = await pool.query("SELECT reclaim_expired_claims() n");
check("sweeper returned the work", rec[0].n === 8, `${rec[0].n} reclaimed`);

const gwFresh = responder();
await new ModerationWorker(pool, gwFresh, cfg).runOnce();
check("a fresh worker completed all 8", (await states("r-")).analyzed === 8, JSON.stringify(await states("r-")));

const { rows: dupe } = await pool.query(
  "SELECT count(*)::int n FROM (SELECT message_id FROM verdicts GROUP BY 1 HAVING count(*)>1) d",
);
check("no message judged twice", dupe[0].n === 0);

// ── 5. Two workers, one queue, no overlap ──────────────────────────────────
console.log("\n[5] two workers draining at once never overlap");
await seed(40, { prefix: "p-" });
const wa = new ModerationWorker(pool, responder(), cfg);
const wb = new ModerationWorker(pool, responder(), cfg);
for (let i = 0; i < 6; i++) await Promise.all([wa.runOnce(), wb.runOnce()]);

const { rows: p } = await pool.query(
  `SELECT count(*)::int n, max(attempts)::int mx FROM messages
    WHERE id LIKE 'p-%' AND ai_status='analyzed'`,
);
check("all 40 judged exactly once", p[0].n === 40, JSON.stringify(p[0]));
check("no message attempted twice", p[0].mx === 1, `max attempts = ${p[0].mx}`);

await pool.end();
console.log(failures === 0 ? "\nPipeline verified end to end." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
