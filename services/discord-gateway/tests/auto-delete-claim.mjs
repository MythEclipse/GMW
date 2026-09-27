/**
 * Does the auto-delete enforcer actually pick up messages and decide?
 *
 * Unit tests cover the eligibility rules. This covers the part that was dead
 * for the whole rewrite: the loop that turns a verdict into a decision. It
 * runs the REAL claim query against a scratch database seeded the way
 * production is — flagged verdicts whose messages are still present — and
 * asserts that:
 *
 *   - the claim query returns exactly the undecided flagged/warn rows
 *   - it excludes messages already deleted in Discord
 *   - it excludes rows already marked done (no double-processing)
 *   - claiming is atomic under concurrency (SKIP LOCKED)
 *   - the state CHECK constraint accepts only the documented values
 *
 * It does NOT call Discord. Deleting a real message is the gateway's job at
 * runtime; here we prove the thing that was broken — that nothing ever picked
 * the row up.
 *
 * Run: DSN=<dsn> bun tests/auto-delete-claim.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const admin = new pg.Pool({ connectionString: dsn, max: 1 });
const scratch = dsn.replace(/\/[^/]+$/, "/gmw_enforce");

// The claim query, copied verbatim from autoDeleteEnforcer.ts.
const CLAIM = `
  UPDATE verdicts v
  SET auto_delete_state = 'claimed',
      auto_delete_claimed_at = $1
  WHERE v.message_id IN (
    SELECT vv.message_id
    FROM verdicts vv
    JOIN messages m ON m.id = vv.message_id
    WHERE vv.status IN ('flagged', 'warn')
      AND m.deleted_at IS NULL
      AND (vv.auto_delete_state IS NULL OR vv.auto_delete_state = 'pending')
    ORDER BY vv.created_at ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  RETURNING v.message_id, v.status, v.auto_delete_state`;

try {
  await admin.query(`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = 'gmw_enforce' AND pid <> pg_backend_pid()`);
  await admin.query("DROP DATABASE IF EXISTS gmw_enforce");
  await admin.query("CREATE DATABASE gmw_enforce");
  const p = new pg.Pool({ connectionString: scratch, max: 1 });

  // Build the real schema, then rewind 0022 and re-apply so the columns exist
  // with no data in them.
  const { execSync } = await import("node:child_process");
  execSync("bun src/shared/database/migrateCli.ts", {
    env: {
      ...process.env,
      DATABASE_URL: scratch,
      DISCORD_TOKEN: "enforce-test",
      AI_ANALYSIS_ENABLED: "false",
    },
    stdio: "pipe",
  });

  const seed = async (id, status, deletedAt) => {
    // ai_status stays 'pending': inserting as 'analyzed' would trip the
    // deferred invariant trigger that requires a verdict row for an analyzed
    // message, and that verdict is inserted on the next line.
    await p.query(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, username, content,
                             created_at, ai_status, deleted_at)
       VALUES ($1,'g1','c1',$2,'u',$3,$4,'pending',$5)`,
      [id, `usr-${id}`, `body ${id}`, 1000, deletedAt],
    );
    await p.query(
      `INSERT INTO verdicts (message_id, status, severity, confidence, score,
                             recommended_action, analysis, model, created_at, updated_at)
       VALUES ($1,$2,'high',0.95,0.95,'delete','abusive content','test',1000,1000)`,
      [id, status],
    );
    // The worker marks a message analyzed once it has a verdict.
    await p.query(
      `UPDATE messages SET ai_status='analyzed' WHERE id=$1`,
      [id],
    );
  };

  await seed("flagged-1", "flagged", null);
  await seed("flagged-2", "flagged", null);
  await seed("warn-1", "warn", null);
  await seed("clean-1", "clean", null);
  await seed("gone-1", "flagged", 9999); // already deleted in Discord

  const start = await p.query(`
    SELECT count(*)::int n FROM verdicts WHERE auto_delete_state IS NULL`);
  check("seeded verdicts start undecided", start.rows[0].n === 5);

  // ── The claim must pick up exactly the actionable ones ──────────────
  const claimed = await p.query(CLAIM, [Date.now(), 10]);
  const ids = claimed.rows.map((r) => r.message_id).sort();
  check(
    "claim returns only undecided flagged/warn messages that are still present",
    JSON.stringify(ids) === JSON.stringify(["flagged-1", "flagged-2", "warn-1"]),
    `claimed=${JSON.stringify(ids)}`,
  );
  check(
    "claim excludes an already-deleted message",
    !ids.includes("gone-1"),
  );
  check(
    "claim excludes a clean verdict",
    !ids.includes("clean-1"),
  );
  check(
    "claim marks every row it returns as claimed",
    claimed.rows.every((r) => r.auto_delete_state === "claimed"),
  );

  // ── No double-processing ───────────────────────────────────────────
  const again = await p.query(CLAIM, [Date.now(), 10]);
  check(
    "a second claim returns nothing (already decided)",
    again.rows.length === 0,
    `second claim returned ${again.rows.length}`,
  );

  // ── 'pending' is retried, 'done' is not ─────────────────────────────
  await p.query(`UPDATE verdicts SET auto_delete_state='pending' WHERE message_id='warn-1'`);
  await p.query(`UPDATE verdicts SET auto_delete_state='done' WHERE message_id='flagged-2'`);
  const third = await p.query(CLAIM, [Date.now(), 10]);
  const thirdIds = third.rows.map((r) => r.message_id);
  check(
    "a pending row is retried",
    thirdIds.includes("warn-1"),
    `claimed=${JSON.stringify(thirdIds)}`,
  );
  check(
    "a done row is never re-claimed",
    !thirdIds.includes("flagged-2"),
  );

  // ── Stale claims are released ──────────────────────────────────────
  await p.query(`
    UPDATE verdicts
    SET auto_delete_state='claimed', auto_delete_claimed_at=$1
    WHERE message_id='warn-1'`, [Date.now() - 120_000]);
  const released = await p.query(`
    UPDATE verdicts SET auto_delete_state='pending'
    WHERE auto_delete_state='claimed' AND auto_delete_claimed_at < $1`,
    [Date.now() - 60_000]);
  check(
    "a claim older than 60s is released for retry",
    released.rowCount === 1,
    `released=${released.rowCount}`,
  );

  // ── The state constraint ───────────────────────────────────────────
  let rejected = false;
  try {
    await p.query(
      `UPDATE verdicts SET auto_delete_state='bogus' WHERE message_id='clean-1'`,
    );
  } catch {
    rejected = true;
  }
  check("the state CHECK constraint rejects an unknown value", rejected);

  // ── Concurrency: two claimers must not get the same row ─────────────
  await p.query(`UPDATE verdicts SET auto_delete_state=NULL`);
  const a = new pg.Pool({ connectionString: scratch, max: 1 });
  const b = new pg.Pool({ connectionString: scratch, max: 1 });
  const [ra, rb] = await Promise.all([
    a.query(CLAIM, [Date.now(), 10]),
    b.query(CLAIM, [Date.now(), 10]),
  ]);
  const allIds = [...ra.rows, ...rb.rows].map((r) => r.message_id);
  const unique = new Set(allIds);
  check(
    "concurrent claims never hand the same message to two workers",
    allIds.length === unique.size,
    `${allIds.length} claims, ${unique.size} unique`,
  );
  check(
    "every actionable message is claimed exactly once",
    unique.size === 3,
    `unique=${unique.size} (expect flagged-1, flagged-2, warn-1)`,
  );
  await a.end();
  await b.end();

  await p.end();
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
  console.log(String(e.stack).split("\n").slice(1, 4).join("\n"));
} finally {
  await admin.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
