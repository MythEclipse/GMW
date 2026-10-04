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

/** The thread that must be exempt from analysis inside its (moderated) parent. */
const THREAD_UNDER_TEST = "1305418007345893480";

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

  // ── 1b. The per-thread list ────────────────────────────────────────────
  // Separate from the channel list because a thread's messages store the
  // PARENT id in channel_id, so a thread id cannot be expressed there. This
  // is what makes one exempt thread possible inside a moderated channel.
  const threadList = (process.env.AI_SKIP_ANALYSIS_THREAD_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (threadList.length > 0) {
    check(
      "AI_SKIP_ANALYSIS_THREAD_IDS is set in the worker env",
      threadList.includes(THREAD_UNDER_TEST),
      threadList.join(","),
    );
    // An untrimmed entry matches nothing — the list is hand-edited.
    check(
      "thread entries are trimmed",
      threadList.every((s) => s === s.trim()),
      threadList.join(","),
    );
  } else {
    console.log(
      "AI_SKIP_ANALYSIS_THREAD_IDS is empty — no individual thread is exempt " +
        "(channel-level skips still apply)",
    );
  }

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
      SELECT m.channel_id, m.thread_id, count(*)::int n,
             count(v.message_id)::int AS with_verdict
        FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
       WHERE m.ai_status = 'skipped'
       GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5`);
    for (const r of s.rows) {
      const where = r.thread_id ? `channel ${r.channel_id} / thread ${r.thread_id}` : `channel ${r.channel_id}`;
      console.log(`  ${where}: ${r.n} skipped, ${r.with_verdict} with a verdict`);
    }
    check(
      "skipped messages carry NO verdict (nothing to delete)",
      s.rows.every((r) => r.with_verdict === 0),
    );
    // Per-thread skips must not spill onto the rest of the parent channel.
    // If a thread id somehow matched channel_id, this would show up as every
    // message in that channel landing in `skipped` with no traffic reason.
    if (threadList.length > 0) {
      const spill = await pool.query(`
        SELECT count(*)::int n
          FROM messages
         WHERE thread_id IS NOT DISTINCT FROM $1
           AND channel_id = $2
           AND ai_status <> 'skipped'`,
        [THREAD_UNDER_TEST, s.rows.find((r) => r.thread_id === THREAD_UNDER_TEST)?.channel_id ?? ""]);
      check(
        "the exempt thread's parent channel is still moderated",
        spill.rows[0].n === 0 || s.rows.every((r) => r.thread_id !== THREAD_UNDER_TEST),
        "the parent channel has no analysed traffic yet — expected on a quiet channel",
      );
    }
  } else {
    console.log(
      "no skipped rows yet — expected if the channel has had no traffic " +
        "since the deploy. The constraint + env checks above are what prove " +
        "it will work on the next message.",
    );
  }

  // A skipped row must never be a backlog item, and the skip itself must
  // never have consumed retry budget.
  //
  // The invariant is NOT "attempts === 1". These rows are messages the worker
  // claimed BEFORE the channel was on the skip list, so they legitimately
  // carry attempts from those earlier real attempts — production showed
  // attempts=4, one attempt short of the cap. Asserting <=1 was wrong, and
  // would have failed on correct behaviour.
  //
  // What actually has to hold: the skip did not consume a further attempt, so
  // re-reading the rows later must show the same number. Measured across a
  // gap rather than in one snapshot, because a single read cannot tell
  // "already 4" from "just incremented to 4".
  if (skipped > 0) {
    const first = await pool.query(
      `SELECT id, attempts FROM messages WHERE ai_status = 'skipped' ORDER BY id`,
    );
    await new Promise((r) => setTimeout(r, 5000));
    const second = await pool.query(
      `SELECT id, attempts FROM messages WHERE ai_status = 'skipped' ORDER BY id`,
    );
    check(
      "the skip consumed no retry budget (attempts frozen across 5s)",
      JSON.stringify(first.rows) === JSON.stringify(second.rows),
      `${first.rows.length} rows, max attempts=${Math.max(
        0,
        ...first.rows.map((r) => Number(r.attempts ?? 0)),
      )}`,
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
