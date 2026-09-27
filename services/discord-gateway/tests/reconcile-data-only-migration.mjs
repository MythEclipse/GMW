/**
 * Reproduces the production failure and proves the fix.
 *
 * THE FAILURE
 * 0021 is data-only: it creates no table, column or function. The reconciler
 * sentinel tested only 0020's objects, so on a database where 0020 had run but
 * the 0021 backfill had not, it reported "schema at latest" — and then stamped
 * 0021 into __drizzle_migrations as applied WITHOUT RUNNING IT. Drizzle only
 * applies migrations newer than the tracked max, so 0021 was skipped forever
 * and 48,290 messages stayed "unjudged" permanently.
 *
 * This builds that exact poisoned state, runs the real reconciler, and asserts
 * the backfill then happens.
 *
 * Run: DSN=<dsn> bun tests/reconcile-data-only-migration.mjs
 */
import fs from "node:fs";
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
// Point the whole process at the scratch database BEFORE any src/ import.
// The `config` singleton is validated on first import, so DATABASE_URL has to
// be correct by then — setting it later silently migrates production.
const SCRATCH = process.env.DSN?.replace(/\/[^/]+$/, "/gmw_reconcile");
process.env.DATABASE_URL = SCRATCH;
process.env.DISCORD_TOKEN ??= "reconcile-test";
process.env.AI_ANALYSIS_ENABLED ??= "false";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const scratch = dsn.replace(/\/[^/]+$/, "/gmw_reconcile");
const admin = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  // ── Build the poisoned state: 0020 applied, 0021 tracked but never run ──
  await admin.query(`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = 'gmw_reconcile' AND pid <> pg_backend_pid()`);
  await admin.query("DROP DATABASE IF EXISTS gmw_reconcile");
  await admin.query("CREATE DATABASE gmw_reconcile");
  const p = new pg.Pool({ connectionString: scratch, max: 1 });

  // Build the schema with the REAL chain, then rewind to "0020 applied, 0021
  // tracked but never run". Hand-rolled tables are not enough: Drizzle applies
  // every migration newer than the marker, so the real chain has to be there.
  const { execSync } = await import("node:child_process");
  execSync("bun src/shared/database/migrateCli.ts", {
    env: {
      ...process.env,
      DATABASE_URL: scratch,
      DISCORD_TOKEN: "reconcile-test",
      AI_ANALYSIS_ENABLED: "false",
    },
    stdio: "pipe",
  });
  await p.query(`DELETE FROM verdicts`);
  await p.query(
    `DELETE FROM "__drizzle_migrations" WHERE created_at = 1788003600000`,
  );

  await p.query(`
    INSERT INTO messages (id, guild_id, channel_id, user_id, username, content,
                          created_at, ai_status, ai_analysis, ai_severity, ai_categories,
                          ai_moderation_flags, ai_confidence, ai_recommended_action,
                          ai_analyzed_at)
    SELECT
      'm' || g,
      'g1', 'c1', 'u' || g, 'user' || g, 'body ' || g,
      1000 + g,
      'pending',
      'analysis text ' || g,
      (ARRAY['none','low','medium','high','critical'])[1 + (g % 5)],
      '["cat"]',
      '["flag"]',
      1,
      (ARRAY['none','warn','review','delete','escalate'])[1 + (g % 5)],
      1000 + g
    FROM generate_series(1, 500) g`);

  // 0020 set these to 'analyzed' but shipped no verdict rows. Replay that: the
  // trigger must be off for the UPDATE, or it correctly refuses the state that
  // 0021 exists to repair.
  // session_replication_role=replica disables user triggers for this
  // connection only — no DDL, nothing left behind on the table.
  const c = await p.connect();
  await c.query("SET session_replication_role = replica");
  await c.query("UPDATE messages SET ai_status = 'analyzed' WHERE id LIKE 'm%'");
  await c.query("SET session_replication_role = origin");
  c.release();

  // The tracking table already says 0021 ran. It did not — that is exactly
  // the poisoned state: Drizzle's marker is present, so Drizzle will skip it.
  await p.query(`
    INSERT INTO "__drizzle_migrations" (hash, created_at)
    VALUES ('0021_backfill_legacy_verdicts@1788003600000', 1788003600000)`);

  const before = await p.query("SELECT count(*)::int n FROM verdicts");
  check("poisoned state starts with no verdicts", before.rows[0].n === 0);

  const tracked = await p.query(`
    SELECT max(created_at) mx FROM "__drizzle_migrations"`);
  check(
    "0021 is already tracked (so Drizzle would skip it)",
    Number(tracked.rows[0].mx) >= 1788003600000,
    `tracked max=${tracked.rows[0].mx}`,
  );

  // ── Run the REAL reconciler against it ──────────────────────────────────
  const { seedDrizzleHistory } = await import("../src/shared/database/migrate.ts");
  await seedDrizzleHistory(p);

  const afterTrack = await p.query(`
    SELECT max(created_at) mx FROM "__drizzle_migrations"`);
  check(
    "reconciler rolled back the false 0021 marker",
    Number(afterTrack.rows[0].mx) < 1788003600000,
    `tracked max=${afterTrack.rows[0].mx}`,
  );

  // ── Now let the REAL migrator apply 0021 for real ───────────────────────
  // runMigrations() opens its own pool from the `config` singleton, which now
  // points at the scratch DB, and closes it in a finally block.
  const { runMigrations } = await import("../src/shared/database/migrate.ts");
  try {
    await runMigrations();
  } catch (e) {
    console.log("   runMigrations threw");
    console.log("     message tail:", e.message.slice(-160));
    console.log("     cause       :", e.cause?.message ?? "(none)");
    console.log("     detail      :", e.detail ?? "(none)");
    console.log("     where       :", e.where ?? "(none)");
  }
  const mid = await p.query(
    'SELECT max(created_at) mx FROM "__drizzle_migrations"',
  );
  console.log("   after runMigrations, tracked max:", mid.rows[0].mx);

  const after = await p.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE model = 'legacy')::int legacy
    FROM verdicts`);
  check(
    "backfill actually ran and filled the table",
    after.rows[0].n === 500,
    `verdicts=${after.rows[0].n} legacy=${after.rows[0].legacy}`,
  );

  const missing = await p.query(`
    SELECT count(*)::int n FROM messages m
    WHERE m.ai_analysis IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.message_id = m.id)`);
  check("no judged message is left unjudged", missing.rows[0].n === 0);

  const trackedFinal = await p.query(`
    SELECT max(created_at) mx FROM "__drizzle_migrations"`);
  check(
    "0021 is now legitimately tracked",
    Number(trackedFinal.rows[0].mx) === 1788003600000,
    `tracked max=${trackedFinal.rows[0].mx}`,
  );

  // The SQL is still valid, so the rehearsal file must not be stale.
  const sql = fs.readFileSync(
    "drizzle/migrations/0021_backfill_legacy_verdicts.sql",
    "utf8",
  );
  check("0021 SQL still contains the insert", /INSERT INTO verdicts/i.test(sql));

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
