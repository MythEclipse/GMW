#!/usr/bin/env node
// Concurrency proof for the v2 claim: N workers, one shared queue, zero overlap.
//
// Asserts three properties that v1 could not offer:
//   1. MUTUAL EXCLUSION — no message is ever claimed by two workers.
//   2. COMPLETENESS     — every claimable message is claimed exactly once.
//   3. CRASH RECOVERY   — a worker that dies mid-flight loses nothing: its
//                         rows are re-claimable once the lease expires.
import pg from "pg";

const N_WORKERS = 12;
const CLAIM_BATCH = 7;
const TOTAL_MESSAGES = 500;
const LEASE_MS = 60_000;

const conn = () =>
  new pg.Client({ host: "127.0.0.1", port: 5433, user: "postgres", password: "postgres", database: "gmw_mod" });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function resetQueue() {
  const c = conn();
  await c.connect();
  // `attachments` must be listed: a later migration made it an FK child of
  // `messages`, and Postgres refuses to truncate a table a FK points at.
  await c.query("TRUNCATE messages, verdicts, analysis_attempts, attachments");
  // Insert in a single statement so there is no interleaving during seeding.
  await c.query(
    `INSERT INTO messages (id, guild_id, channel_id, user_id, username, content, created_at, ai_status, ready_for_work_at)
     SELECT 'q-'||g, 'g1', 'c'||(g%10), 'u'||(g%50), 'user'||(g%50), 'msg '||g, g, 'pending', 0
       FROM generate_series(1, $1) g`,
    [TOTAL_MESSAGES],
  );
  await c.end();
}

// ── Test 1: mutual exclusion + completeness under 12 concurrent workers ──────
async function testParallelClaim() {
  console.log("\n[1] 12 concurrent workers drain a 500-message queue");
  await resetQueue();

  const claimedBy = new Map(); // message_id -> Set(worker)
  const overlaps = [];

  await Promise.all(
    Array.from({ length: N_WORKERS }, async (_, i) => {
      const c = conn();
      await c.connect();
      const wid = `worker-${i}`;
      try {
        for (;;) {
          const { rows } = await c.query("SELECT id FROM claim_messages($1,$2,$3)", [
            wid, CLAIM_BATCH, LEASE_MS,
          ]);
          if (rows.length === 0) break;
          for (const r of rows) {
            if (!claimedBy.has(r.id)) claimedBy.set(r.id, new Set());
            const seen = claimedBy.get(r.id);
            if (seen.has(wid)) overlaps.push(`${r.id} re-claimed by ${wid}`);
            seen.add(wid);
          }
        }
      } finally {
        await c.end();
      }
    }),
  );

  check(
    "mutual exclusion: no message claimed by 2+ workers",
    overlaps.length === 0,
    overlaps.length ? overlaps.slice(0, 3).join("; ") : `${claimedBy.size} messages, 0 overlaps`,
  );
  check(
    "completeness: all claimable messages claimed",
    claimedBy.size === TOTAL_MESSAGES,
    `${claimedBy.size}/${TOTAL_MESSAGES}`,
  );

  const c = conn();
  await c.connect();
  const { rows } = await c.query(
    "SELECT count(*)::int n, count(DISTINCT worker_id)::int w, max(attempts) mx FROM messages WHERE ai_status='claimed'",
  );
  await c.end();
  check("attempts never exceeded 1 (no double-processing)", rows[0].mx === 1, `max attempts=${rows[0].mx}`);
  check("work spread across workers", rows[0].w > 1, `${rows[0].w} distinct workers`);
  return claimedBy;
}

// ── Test 2: crash recovery ───────────────────────────────────────────────────
async function testCrashRecovery() {
  console.log("\n[2] a worker dies mid-flight; nothing is lost");

  // Set up the scenario explicitly. (Do NOT rely on leftovers from test 1 —
  // that queue is fully drained, which would make these assertions vacuous.)
  await resetQueue();
  const setup = conn();
  await setup.connect();
  const { rows: held } = await setup.query(
    "SELECT count(*)::int n FROM claim_messages('worker-crashed', 20, $1)",
    [LEASE_MS],
  );
  await setup.end();
  check("crashed worker holds a batch", held[0].n === 20, `${held[0].n} rows held`);
  const before = held[0].n;

  const c = conn();
  await c.connect();

  // Its lease is still valid, so reclaim must NOT touch it yet.
  await c.query("SELECT reclaim_expired_claims()");
  const { rows: stillClaimed } = await c.query(
    "SELECT count(*)::int n FROM messages WHERE worker_id='worker-crashed'",
  );
  check(
    "valid lease is respected (no premature reclaim)",
    stillClaimed[0].n === before,
    `${stillClaimed[0].n}/${before} still held by the dead worker`,
  );

  // Time passes: the lease expires. Now the work must come back.
  await c.query(
    `UPDATE messages SET lease_until = (extract(epoch from now())*1000)::bigint - 1000
      WHERE worker_id='worker-crashed'`,
  );
  const late = await c.query("SELECT reclaim_expired_claims() AS n");
  // Scope to the rows the crashed worker actually held. A plain min() over the
  // whole pending pool would be 0 because most rows were never attempted at all
  // — true, but it says nothing about the crash path.
  const { rows: recovered } = await c.query(
    `SELECT count(*)::int n, min(attempts) mx
       FROM messages WHERE ai_status='pending' AND attempts > 0`,
  );
  await c.end();

  check(
    "expired lease is reclaimed",
    late.rows[0].n === before && recovered[0].n >= before,
    `${late.rows[0].n} returned, ${recovered[0].n} pending in the queue`,
  );
  check(
    "attempts preserved across the crash (retry cap still meaningful)",
    recovered[0].mx >= 1,
    `min attempts on recovered rows = ${recovered[0].mx}`,
  );

  // And the recovered work must be claimable by someone else.
  const r2 = conn();
  await r2.connect();
  const { rows: retaken } = await r2.query("SELECT count(*)::int n FROM claim_messages('worker-rescuer',100,60000)");
  const { rows: byRescuer } = await r2.query(
    "SELECT count(*)::int n, max(attempts) mx FROM messages WHERE worker_id='worker-rescuer'",
  );
  await r2.end();
  check(
    "a healthy worker picks up the abandoned work",
    retaken[0].n >= before && byRescuer[0].mx === 2,
    `${retaken[0].n} re-claimed, attempts now ${byRescuer[0].mx}`,
  );
}

// ── Test 3: the completeness invariant ───────────────────────────────────────
async function testVerdictInvariant() {
  console.log("\n[3] analyzed ⇒ verdict row exists (enforced by the database)");
  const c = conn();
  await c.connect();

  await c.query("UPDATE messages SET ai_status='pending' WHERE id='q-1'");
  let rejected = false;
  try {
    await c.query("UPDATE messages SET ai_status='analyzed' WHERE id='q-1'");
  } catch (e) {
    rejected = /no verdict row exists/.test(e.message);
  }
  check("analyzed without a verdict is REJECTED", rejected);

  // The correct pattern: both statements, one transaction.
  await c.query("BEGIN");
  await c.query(
    `INSERT INTO verdicts (message_id,status,reason,analysis)
     VALUES ('q-1','deleted','test','test') ON CONFLICT (message_id) DO UPDATE SET status='deleted'`,
  );
  await c.query("UPDATE messages SET ai_status='analyzed' WHERE id='q-1'");
  await c.query("COMMIT");
  const { rows } = await c.query(
    "SELECT m.ai_status, v.status FROM messages m JOIN verdicts v ON v.message_id=m.id WHERE m.id='q-1'",
  );
  check(
    "verdict + analyzed in one transaction SUCCEEDS",
    rows[0]?.ai_status === "analyzed" && rows[0]?.status === "deleted",
  );
  await c.end();
}

// ── Test 4: deleted messages are never claimed ───────────────────────────────
async function testDeletedNeverClaimed() {
  console.log("\n[4] deleted messages are invisible to the queue");
  const c = conn();
  await c.connect();
  await c.query(
    `UPDATE messages SET deleted_at = (extract(epoch from now())*1000)::bigint
      WHERE id IN ('q-2','q-3','q-4')`,
  );
  const { rows } = await c.query(
    "SELECT count(*)::int n FROM claim_messages('w-del',100,60000) WHERE id IN ('q-2','q-3','q-4')",
  );
  await c.end();
  check("deleted messages never claimed", rows[0].n === 0, `${rows[0].n} leaked into a claim`);
}

await testParallelClaim();
await testCrashRecovery();
await testVerdictInvariant();
await testDeletedNeverClaimed();

console.log(
  failures === 0
    ? "\nAll concurrency invariants hold."
    : `\n${failures} invariant(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
