/**
 * Copies the legacy moderation columns out of production into a scratch
 * database, so a backfill can be rehearsed before it touches real data.
 *
 * Run: DSN=<prod dsn> bun tests/build-legacy-replica.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}

const src = new pg.Pool({ connectionString: dsn, max: 1 });
const target = dsn.replace(/\/[^/]+$/, "/gmw_backfill");

const COLS = [
  "id",
  "ai_status",
  "ai_analysis",
  "ai_severity",
  "ai_categories",
  "ai_moderation_flags",
  "ai_confidence",
  "ai_moderation_score",
  "ai_recommended_action",
  "ai_analyzed_at",
  "ai_analysis_duration_ms",
  "created_at",
];

try {
  // A previous aborted run can leave idle connections holding the DB open, and
  // DROP DATABASE refuses while any exist. Terminate them first.
  await src.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = 'gmw_backfill' AND pid <> pg_backend_pid()
  `);
  await src.query("DROP DATABASE IF EXISTS gmw_backfill");
  await src.query("CREATE DATABASE gmw_backfill");
  const dst = new pg.Pool({ connectionString: target, max: 1 });

  await dst.query(`
    CREATE TABLE messages (
      id text PRIMARY KEY,
      ai_status text NOT NULL DEFAULT 'pending',
      ai_analysis text,
      ai_severity text,
      ai_categories text,
      ai_moderation_flags text,
      ai_confidence real,
      ai_moderation_score real,
      ai_recommended_action text,
      ai_analyzed_at bigint,
      ai_analysis_duration_ms int,
      created_at bigint
    )`);

  // Copy the shape of the real `verdicts` table so the rehearsal sees the same
  // constraints the production backfill will hit.
  await dst.query(`
    CREATE TABLE verdicts (
      message_id text PRIMARY KEY,
      status text NOT NULL,
      flags text[] NOT NULL DEFAULT '{}',
      categories text[] NOT NULL DEFAULT '{}',
      severity text NOT NULL DEFAULT 'none',
      confidence real NOT NULL DEFAULT 0,
      score real,
      recommended_action text NOT NULL DEFAULT 'none',
      analysis text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      policy_version text,
      model text,
      duration_ms int,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      CONSTRAINT verdicts_status_check   CHECK (status IN ('clean','warn','flagged','error')),
      CONSTRAINT verdicts_severity_check CHECK (severity IN ('none','low','medium','high','critical')),
      CONSTRAINT verdicts_action_check   CHECK (recommended_action IN ('none','monitor','warn','review','delete','escalate'))
    )`);

  const { rows } = await src.query(
    `SELECT ${COLS.join(", ")} FROM messages WHERE ai_analysis IS NOT NULL`,
  );
  console.log(`replicating ${rows.length} legacy rows...`);

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    // Explicit placeholders: one $n per column per row, 1-indexed across the
    // whole statement. Computing these by hand is how you get a
    // "6000 parameters but requires 5501" bind error.
    const placeholders = chunk
      .map((_, r) => `(${COLS.map((__, c) => `$${r * COLS.length + c + 1}`).join(",")})`)
      .join(",");
    const params = chunk.flatMap((r) => COLS.map((c) => r[c] ?? null));
    await dst.query(
      `INSERT INTO messages (${COLS.join(",")}) VALUES ${placeholders}`,
      params,
    );
  }

  // Real distributions matter: the rehearsal must hit the same
  // confidence=0 / severity=none / empty-categories shapes.
  const dist = await dst.query(`
    SELECT ai_severity, ai_recommended_action, count(*)::int n
    FROM messages GROUP BY 1,2 ORDER BY 3 DESC LIMIT 6`);
  console.log("replicated severity x action:");
  for (const d of dist.rows) console.log("  ", JSON.stringify(d));

  console.log("gmw_backfill ready");
  await dst.end();
} finally {
  await src.end();
}
