/**
 * Rehearses the legacy-verdict backfill against the scratch replica and
 * asserts the result, without touching production.
 *
 * The replica (gmw_backfill) is a copy of production's legacy columns plus a
 * faithful `verdicts` table, built by build-legacy-replica.mjs. The failure
 * this guards against is specific: the dashboard showed 48,290 messages as
 * "unjudged" because migration 0020 moved the judgement to `verdicts` without
 * copying it, so a wrong backfill would either invent verdicts or corrupt
 * history that is still intact in the legacy columns.
 *
 * Run: DSN=<prod dsn> bun tests/rehearse-verdict-backfill.mjs
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

const pool = new pg.Pool({
  connectionString: dsn.replace(/\/[^/]+$/, "/gmw_backfill"),
  max: 1,
});

try {
  const before = await pool.query(
    "SELECT count(*)::int n FROM messages WHERE ai_analysis IS NOT NULL",
  );
  const v0 = await pool.query("SELECT count(*)::int n FROM verdicts");
  check("replica starts with no verdicts", v0.rows[0].n === 0, `messages=${before.rows[0].n} verdicts=${v0.rows[0].n}`);

  const sql = fs.readFileSync(
    "drizzle/migrations/0021_backfill_legacy_verdicts.sql",
    "utf8",
  );
  const inserted = await pool.query(sql);
  check("backfill applied", inserted.rowCount > 0, `${inserted.rowCount} rows`);

  // ── Every judged message now has a verdict ─────────────────────────────
  const after = await pool.query(`
    SELECT
      count(*) FILTER (WHERE m.ai_analysis IS NOT NULL)::int AS judged,
      count(*) FILTER (WHERE m.ai_analysis IS NOT NULL AND v.message_id IS NOT NULL)::int AS judged_with_verdict,
      count(*) FILTER (WHERE m.ai_analysis IS NOT NULL AND v.message_id IS NULL)::int AS judged_still_missing
    FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
  `);
  const a = after.rows[0];
  check(
    "no judged message is left without a verdict",
    a.judged_still_missing === 0,
    `judged=${a.judged} with_verdict=${a.judged_with_verdict} missing=${a.judged_still_missing}`,
  );
  check(
    "backfilled count equals judged count",
    a.judged === a.judged_with_verdict,
    `${a.judged_with_verdict}/${a.judged}`,
  );

  // ── Values are COPIED, not invented ────────────────────────────────────
  const drift = await pool.query(`
    SELECT count(*)::int n
    FROM messages m JOIN verdicts v ON v.message_id = m.id
    WHERE v.severity IS DISTINCT FROM COALESCE(m.ai_severity, 'none')
       OR v.recommended_action IS DISTINCT FROM COALESCE(m.ai_recommended_action, 'none')
       OR v.analysis IS DISTINCT FROM COALESCE(m.ai_analysis, '')
       OR v.score IS DISTINCT FROM m.ai_moderation_score
  `);
  // duration_ms is deliberately NOT compared: no migration creates
  // ai_analysis_duration_ms, so the backfill cannot read it (referencing it
  // made the migration fail on any clean database). It stays NULL.
  check(
    "every copied field matches the legacy column exactly",
    drift.rows[0].n === 0,
    `drifted rows=${drift.rows[0].n}`,
  );

  // ── status is derived consistently from severity + action ──────────────
  const badStatus = await pool.query(`
    SELECT count(*)::int n FROM verdicts
    WHERE status IS DISTINCT FROM CASE
      WHEN recommended_action IN ('delete','escalate') THEN 'flagged'
      WHEN recommended_action IN ('warn','review')    THEN 'warn'
      ELSE 'clean' END
  `);
  check("status always follows the documented mapping", badStatus.rows[0].n === 0, `violations=${badStatus.rows[0].n}`);

  // ── JSON string -> text[] conversion ───────────────────────────────────
  const arr = await pool.query(`
    SELECT count(*)::int n FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE COALESCE(NULLIF(m.ai_moderation_flags,''),'[]')::jsonb <> to_jsonb(v.flags)
  `);
  check("flags array round-trips from the legacy JSON string", arr.rows[0].n === 0, `mismatched=${arr.rows[0].n}`);

  // ── every row is marked as reconstructed, never as live output ─────────
  const models = await pool.query("SELECT model, count(*)::int n FROM verdicts GROUP BY 1");
  check(
    "all backfilled rows are marked model='legacy'",
    models.rows.length === 1 && models.rows[0].model === "legacy",
    JSON.stringify(models.rows),
  );

  // ── created_at is never 0 (would break every time filter) ─────────────
  const zero = await pool.query(
    "SELECT count(*)::int n FROM verdicts WHERE created_at = 0 OR updated_at = 0",
  );
  check("no verdict has a zero timestamp", zero.rows[0].n === 0, `zeroed=${zero.rows[0].n}`);

  // ── distribution sanity ────────────────────────────────────────────────
  const dist = await pool.query(
    "SELECT status, count(*)::int n FROM verdicts GROUP BY 1 ORDER BY 2 DESC",
  );
  console.log("   distribution:", JSON.stringify(dist.rows));
  check(
    "flagged rows match the legacy delete+escalate count",
    Number(dist.rows.find((d) => d.status === "flagged")?.n) === 640,
    `delete=635 + escalate=5 = 640`,
  );

  // ── IDEMPOTENT: re-running must not double-write or overwrite ─────────
  const again = await pool.query(sql);
  const count2 = await pool.query("SELECT count(*)::int n FROM verdicts");
  check(
    "re-running the backfill inserts nothing new",
    count2.rows[0].n === a.judged_with_verdict,
    `inserted=${again.rowCount} total=${count2.rows[0].n}`,
  );

  // A pre-existing verdict must survive a re-run.
  await pool.query(
    `INSERT INTO verdicts (message_id, status, analysis, model, created_at, updated_at)
     VALUES ('__sentinel__', 'clean', 'written by the live worker', 'text', 1, 1)
     ON CONFLICT (message_id) DO NOTHING`,
  );
  await pool.query(sql);
  const sentinel = await pool.query(
    "SELECT model, analysis FROM verdicts WHERE message_id='__sentinel__'",
  );
  check(
    "an existing verdict is never overwritten",
    sentinel.rows[0]?.model === "text" && sentinel.rows[0]?.analysis === "written by the live worker",
    JSON.stringify(sentinel.rows[0]),
  );
  await pool.query("DELETE FROM verdicts WHERE message_id='__sentinel__'");
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
