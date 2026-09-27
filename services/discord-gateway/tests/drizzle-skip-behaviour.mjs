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
  await p.query(`DELETE FROM verdicts`);
  await p.query(
    `DELETE FROM "__drizzle_migrations" WHERE created_at = 1788003600000`,
  );

  // Real NOT NULL columns, no defaults: id, guild_id, channel_id, user_id,
  // username, content, created_at.
  await p.query(`
    INSERT INTO messages (id, guild_id, channel_id, user_id, username, content,
                          created_at, ai_status, ai_analysis, ai_severity,
                          ai_categories, ai_moderation_flags, ai_confidence,
                          ai_recommended_action, ai_analyzed_at)
    SELECT 'd' || g, 'g1', 'c1', 'u' || g, 'user' || g, 'body ' || g,
           2000 + g, 'pending', 'text ' || g, 'medium', '[]', '[]', 1, 'delete',
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
  await admin.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
