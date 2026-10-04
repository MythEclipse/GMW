/**
 * Asks Drizzle DIRECTLY to apply 0021 on a database that already tracks it.
 *
 * The reconciler fix removes the false marker so Drizzle will run the
 * migration. This proves the other half of that claim: that Drizzle actually
 * does skip a migration whose `when` is already in __drizzle_migrations, and
 * runs it once the row is gone. Without this, "we deleted the marker" is an
 * assumption rather than a verified mechanism.
 *
 * Run: DSN=<dsn> bun tests/drizzle-skip-behaviour.mjs
 */
import fs from "node:fs";
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

const JOURNAL = "drizzle/migrations/meta/_journal.json";
// Read the pristine journal up front: the `finally` needs it to restore, and it
// is read before anything can truncate it. The raw text is kept too, so the
// restore is byte-identical (JSON.stringify drops the trailing newline).
const JOURNAL_RAW = fs.readFileSync(JOURNAL, "utf8");
const full = JSON.parse(JOURNAL_RAW);

/**
 * Truncate the migration journal so it ends at `lastTag` (in place).
 *
 * The journal must be cut at 0021, NOT 0020. Cutting at 0020 means 0021 is
 * absent from the journal entirely, so `migrate()` in Case 2 has nothing to
 * run and "Drizzle applies 0021" can never pass. Cutting at 0021 keeps 0021
 * visible to Drizzle while excluding everything above it — which is the whole
 * point: 0021 INSERTs into verdicts.severity and verdicts.recommended_action,
 * which 0025 drops, so replaying it against a post-0025 schema is impossible.
 */
function truncateJournalTo(lastTag) {
  const trimmed = JSON.parse(JSON.stringify(full));
  trimmed.entries = trimmed.entries.filter((e) => e.tag <= lastTag);
  fs.writeFileSync(JOURNAL, `${JSON.stringify(trimmed, null, 2)}\n`);
}

const admin = new pg.Pool({ connectionString: dsn, max: 1 });
const scratch = dsn.replace(/\/[^/]+$/, "/gmw_direct");

try {
  await admin.query(`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = 'gmw_direct' AND pid <> pg_backend_pid()`);
  await admin.query("DROP DATABASE IF EXISTS gmw_direct");
  await admin.query("CREATE DATABASE gmw_direct");
  const p = new pg.Pool({ connectionString: scratch, max: 1 });

  // Build the schema with the REAL migration chain up to 0020, then stamp
  // 0021 as tracked. Hand-writing a minimal `messages` table is not enough:
  // Drizzle applies every migration newer than the marker, so 0021 is preceded
  // by the whole chain and any missing column (e.g. channel_id) fails it.
  // Build the schema from a chain TRUNCATED AT 0020, then restore the journal.
  //
  // The whole current chain cannot be used: it ends at 0025, which DROPS
  // verdicts.severity and verdicts.recommended_action — the exact two columns
  // 0021 INSERTs into. With a post-0025 schema in place, replaying 0021 is
  // impossible (and Drizzle records its marker regardless), so the probe would
  // "pass" a skip test while proving nothing about the backfill. Truncating the
  // journal is what makes the state genuine at-0020.
  // Keep the journal at 0020 for the WHOLE probe, not just the setup: the two
  // `migrate()` calls below read it too. Restoring it early makes those calls
  // apply 0022..0025, which advances the tracked max past 0021 — and then
  // "delete 0021's marker, expect it to run" can never pass, because Drizzle
  // only applies migrations NEWER than the max.
  truncateJournalTo("0021_backfill_legacy_verdicts");
  const { execSync } = await import("node:child_process");
  execSync("bun src/shared/database/migrateCli.ts", {
    env: {
      ...process.env,
      DATABASE_URL: scratch,
      DISCORD_TOKEN: "direct-test",
      AI_ANALYSIS_ENABLED: "false",
    },
    stdio: "pipe",
  });
  // The chain includes 0021, so remove both its marker and its effect to get
  // back to a genuine "0020 only" state.
  // Rewind EVERY marker from 0021 up, not just 0021's. Drizzle applies only
  // migrations NEWER than the tracked max, so with 0022..0025 still tracked the
  // max stays at 0025 and 0021 is skipped forever no matter what its own row
  // says. The later markers go too, which is safe because their DDL effects
  // are already present in this schema and Drizzle's own bookkeeping is what we
  // are rewinding, not the objects.
  await p.query(`DELETE FROM verdicts`);
  await p.query(
    `DELETE FROM "__drizzle_migrations" WHERE created_at >= 1788003600000`,
  );

  // Real NOT NULL columns, no defaults: id, guild_id, channel_id, user_id,
  // username, content, created_at.
  // `ai_severity` / `ai_recommended_action` are dropped by migration 0025, and
  // this scratch schema comes from running the whole current chain, so the seed
  // must not name them. The legacy judgement this test needs 0021 to backfill
  // is carried by `ai_analysis`, which 0021 also requires to be non-null.
  await p.query(`
    INSERT INTO messages (id, guild_id, channel_id, user_id, username, content,
                          created_at, ai_status, ai_analysis,
                          ai_categories, ai_moderation_flags, ai_confidence,
                          ai_analyzed_at)
    SELECT 'd' || g, 'g1', 'c1', 'u' || g, 'user' || g, 'body ' || g,
           2000 + g, 'pending', 'text ' || g, '[]', '[]', 1,
           2000 + g
    FROM generate_series(1, 50) g`);
  // ai_status stays 'pending': seeding it as 'analyzed' would trip the very
  // invariant 0020 installs (deferred trigger, fires at COMMIT), which is the
  // constraint doing its job, not a bug in this test.

  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const db = drizzle(p);

  // ── Case 1: 0021 tracked → Drizzle must SKIP it ────────────────────────
  await p.query(`
    INSERT INTO "__drizzle_migrations" (hash, created_at)
    VALUES ('0021_backfill_legacy_verdicts@1788003600000', 1788003600000)`);
  await migrate(db, {
    migrationsFolder: "./drizzle/migrations",
    migrationsSchema: "public",
  });
  const skipped = await p.query("SELECT count(*)::int n FROM verdicts");
  check(
    "Drizzle SKIPS 0021 while its marker is present",
    skipped.rows[0].n === 0,
    `verdicts=${skipped.rows[0].n} — this is why deleting the marker is required`,
  );

  // ── Case 2: marker removed → Drizzle must APPLY it ─────────────────────
  await p.query(
    `DELETE FROM "__drizzle_migrations" WHERE created_at = 1788003600000`,
  );
  await migrate(db, {
    migrationsFolder: "./drizzle/migrations",
    migrationsSchema: "public",
  });
  const applied = await p.query("SELECT count(*)::int n FROM verdicts");
  check(
    "Drizzle APPLIES 0021 once the marker is gone",
    applied.rows[0].n === 50,
    `verdicts=${applied.rows[0].n}`,
  );

  const reTracked = await p.query(`
    SELECT max(created_at) mx FROM "__drizzle_migrations"`);
  check(
    "Drizzle re-stamps the marker after applying",
    Number(reTracked.rows[0].mx) === 1788003600000,
    `tracked max=${reTracked.rows[0].mx}`,
  );

  await p.end();
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
} finally {
  // ALWAYS restore the journal, even on throw: leaving it at 0020 would
  // silently disable 0021..0025 in every later run, including production.
  try {
    fs.writeFileSync(JOURNAL, JOURNAL_RAW);
  } catch (e) {
    console.log(`FAIL  could not restore the migration journal — ${e.message}`);
    fail++;
  }
  await admin.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
