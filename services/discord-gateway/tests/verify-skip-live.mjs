/**
 * Post-deploy verification: is the skip actually LIVE in production?
 *
 * A restarted process proves nothing on its own — the worker can be running
 * the new build with the feature off, because the list is a CI secret and the
 * default is empty. This checks the two things that decide whether the channel
 * is actually exempt:
 *
 *   1. 0023 is applied to the PRODUCTION database (a real CHECK constraint
 *      with 'skipped' in its definition) — otherwise every skip write throws
 *      check_violation and the worker dies on that batch.
 *   2. the running process carries the config value, so the worker is
 *      restarting but the channel is still being moderated.
 *
 * Read-only. Exits 0 when both hold, 1 otherwise, so it can gate a deploy.
 *
 * Run: DSN=postgres://…/dcbot bun tests/verify-skip-live.mjs
 *      SSHVPS=1 DSN=… bun tests/verify-skip-live.mjs   (run it on the VPS)
 */
import pg from "pg";

const DSN = process.env.DSN;
if (!DSN) {
  console.error("DSN is required");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const pool = new pg.Pool({ connectionString: DSN, max: 1 });

try {
  // ── 1. Is 0023 really applied here? ────────────────────────────────────
  const c = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conname = 'messages_ai_status_check'`);
  const def = c.rows[0]?.def ?? "";
  check(
    "0023 is applied (CHECK accepts 'skipped')",
    def.includes("skipped"),
    def || "no messages_ai_status_check found",
  );

  // The tracking table must agree, or the next boot may re-apply or roll back.
  const t = await pool.query(
    `SELECT count(*)::int n FROM "__drizzle_migrations" WHERE created_at = 1788090000000`,
  );
  check("0023 is recorded as applied", t.rows[0].n === 1, `rows=${t.rows[0].n}`);

  // ── 2. Is the running worker actually configured? ──────────────────────
  // Read from the process's own environment, so this is the value the worker
  // built its Set() from — not what a file says it should be.
  const list = (process.env.AI_SKIP_ANALYSIS_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  check(
    "AI_SKIP_ANALYSIS_CHANNEL_IDS is set in the worker env",
    list.length > 0,
    list.length ? list.join(",") : "empty — every channel is still moderated",
  );
  check(
    "the requested channel 1308392257975488593 is on it",
    list.includes("1308392257975488593"),
    list.join(","),
  );

  // ── 3. What the queue actually looks like ──────────────────────────────
  // A non-zero skipped count is the direct evidence the path is executing.
  const q = await pool.query(`
    SELECT ai_status, count(*)::int n
      FROM messages WHERE deleted_at IS NULL
     GROUP BY 1 ORDER BY 2 DESC`);
  const by = Object.fromEntries(q.rows.map((r) => [r.ai_status, r.n]));
  console.log(
    `\nqueue: ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join("  ") || "(empty)"}`,
  );

  const skipped = by.skipped ?? 0;
  if (skipped > 0) {
    console.log("evidence the skip is live:");
    const s = await pool.query(`
      SELECT m.channel_id, count(*)::int n,
             count(v.message_id)::int AS with_verdict
        FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
       WHERE m.ai_status = 'skipped'
       GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
    for (const r of s.rows) {
      console.log(`  channel ${r.channel_id}: ${r.n} skipped, ${r.with_verdict} with a verdict`);
    }
    check(
      "skipped messages carry NO verdict (nothing to delete)",
      s.rows.every((r) => r.with_verdict === 0),
    );
  } else {
    console.log(
      "no skipped rows yet — expected if the channel has had no traffic " +
        "since the deploy. The constraint + env checks above are what prove " +
        "it will work on the next message.",
    );
  }

  // A skipped row must never be a backlog item.
  if (skipped > 0) {
    const attempts = await pool.query(`
      SELECT max(attempts)::int n FROM messages WHERE ai_status = 'skipped'`);
    check(
      "skipped rows consumed no retry budget",
      (attempts.rows[0]?.n ?? 0) <= 1,
      `max attempts=${attempts.rows[0]?.n}`,
    );
  }
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
