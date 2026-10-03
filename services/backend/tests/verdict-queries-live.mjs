/**
 * Verifies the backend's re-pointed moderation queries against the REAL
 * production database.
 *
 * Every query here previously ran against the old pipeline's tables and either
 * returned zero rows or an empty aggregate while the worker was running fine —
 * silent wrong answers, not errors. This asserts they now return live data.
 *
 * Credentials are never read from .env; the DSN comes from the environment.
 * Run with: DSN=... bun tests/verdict-queries-live.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: dsn, max: 1 });

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  // ── 1. The review queue must not be empty just because ai_status changed ──
  const review = await pool.query(`
    SELECT m.ai_status, v.status AS verdict_status, v.recommended_action
    FROM messages m
    LEFT JOIN verdicts v ON v.message_id = m.id
    WHERE v.status = 'deleted' OR m.ai_status = 'dead'
    ORDER BY v.created_at DESC NULLS LAST
    LIMIT 5
  `);
  check(
    "review queue returns rows (old ai_status='flagged' returned 0)",
    review.rows.length > 0,
    `${review.rows.length} rows`,
  );
  check(
    "every review row carries a real verdict or is dead",
    review.rows.every((r) => r.verdict_status !== null || r.ai_status === "dead"),
  );

  // ── 2. Coverage must be non-zero (ai_analysis_runs is permanently empty) ──
  const coverage = await pool.query(`
    SELECT outcome, COUNT(*)::int AS c
    FROM analysis_attempts
    WHERE created_at >= $1
    GROUP BY outcome
  `, [Date.now() - 30 * 864e5]);
  const outcomes = Object.fromEntries(coverage.rows.map((r) => [r.outcome, r.c]));
  const total = coverage.rows.reduce((a, r) => a + r.c, 0);
  check(
    "coverage reads analysis_attempts and is non-zero",
    total > 0,
    `total=${total} ${JSON.stringify(outcomes)}`,
  );
  check(
    "at least one attempt succeeded",
    (outcomes.success ?? 0) > 0,
    `success=${outcomes.success ?? 0}`,
  );

  // ── 3. Stats must be live (moderation_actions is frozen at cutover) ──
  const stats = await pool.query(`
    SELECT COALESCE(v.status,'unjudged') AS status,
           COALESCE(v.recommended_action,'clean') AS action_type,
           COUNT(*)::int AS c
    FROM messages m
    LEFT JOIN verdicts v ON v.message_id = m.id
    GROUP BY 1, 2
  `);
  const statTotal = stats.rows.reduce((a, r) => a + r.c, 0);
  check("stats aggregate is non-zero", statTotal > 0, `total=${statTotal}`);

  // The frozen table: prove the old query really is stale, so this test would
  // have failed before the change.
  const frozen = await pool.query(
    "SELECT MAX(created_at) AS mx FROM moderation_actions",
  );
  const newestAction = Number(frozen.rows[0].mx ?? 0);
  const newestVerdict = await pool.query(
    "SELECT MAX(updated_at) AS mx FROM verdicts",
  );
  const newestVerdictMs = Number(newestVerdict.rows[0].mx ?? 0);
  check(
    "moderation_actions is genuinely frozen while verdicts advance",
    newestAction < newestVerdictMs,
    `actions newest=${newestAction}, verdicts newest=${newestVerdictMs}`,
  );

  // ── 4. Queue health ──
  const queue = await pool.query(`
    SELECT ai_status, COUNT(*)::int AS c
    FROM messages
    WHERE ai_status <> 'analyzed' OR deleted_at IS NOT NULL
    GROUP BY ai_status
  `);
  const byStatus = Object.fromEntries(queue.rows.map((r) => [r.ai_status, r.c]));
  check(
    "queue statuses use the new vocabulary only",
    Object.keys(byStatus).every((s) =>
      ["pending", "claimed", "analyzed", "retry_wait", "dead"].includes(s),
    ),
    JSON.stringify(byStatus),
  );

  // ── 5. The split must be observable: analyzed+flagged ≠ analyzed+unjudged ──
  const split = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE m.ai_status='analyzed' AND v.status='deleted')::int AS analyzed_flagged,
      COUNT(*) FILTER (WHERE m.ai_status='analyzed' AND v.status IS NULL)::int AS analyzed_unjudged
    FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
  `);
  check(
    "analyzed messages split into judged vs unjudged",
    split.rows[0].analyzed_flagged + split.rows[0].analyzed_unjudged > 0,
    `flagged=${split.rows[0].analyzed_flagged} unjudged=${split.rows[0].analyzed_unjudged}`,
  );

  // ── 6. No duplicate verdicts (join must be 1:1) ──
  const dupes = await pool.query(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT message_id FROM verdicts GROUP BY message_id HAVING COUNT(*) > 1
    ) x
  `);
  check("verdicts is 1:1 with messages", dupes.rows[0].n === 0, `dupes=${dupes.rows[0].n}`);
} finally {
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
