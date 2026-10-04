/**
 * End-to-end proof against the REAL production database that the backend's own
 * service layer returns live moderation data.
 *
 * This imports the real backend modules and calls the actual repository methods
 * — not hand-copied SQL. If the Drizzle schema, the joins, or the mappers were
 * wrong, this fails. dashboard-verdict-live.mjs only proves the SQL is right.
 *
 * Imports come from src/, not dist/, because the repositories import via the
 * "@/..." alias which resolves to src/. Importing dist/ here would load a
 * second copy of the database module and every call would fail with
 * "Database not initialized".
 *
 * Run with: DSN=... bun tests/be-verdict-service-live.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
process.env.DATABASE_URL = dsn;
// The backend validates its entire config at import time, so a DB-only test
// still has to satisfy the other required vars. None of them are read by the
// read-only code paths exercised here.
process.env.DISCORD_TOKEN ??= "not-used-by-this-test";
process.env.JWT_SECRET ??= "not-used-by-this-test";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  const { initializeDatabase, getDatabase, closeDatabase } = await import(
    "../src/shared/database/init.ts"
  );
  const { config } = await import("../src/shared/config/index.ts");
  const { moderationRepository } = await import(
    "../src/modules/moderation/moderation.repository.ts"
  );
  const { messagesRepository } = await import(
    "../src/modules/messages/messages.repository.ts"
  );
  const { dashboardRepository } = await import(
    "../src/modules/dashboard/dashboard.repository.ts"
  );

  // initializeDatabase takes the validated config as a parameter — it does not
  // read process.env itself, so passing nothing throws on `cfg.DATABASE_URL`.
  const schema = await import("../src/shared/database/schema.ts");
  await initializeDatabase(config, schema);

  // ── moderation.getStats ─────────────────────────────────────────────────
  const stats = await moderationRepository.getStats();
  check("getStats returns a non-zero total", stats.total > 0, `total=${stats.total}`);
  check(
    "getStats is not all-failed",
    stats.failed < stats.total,
    `executed=${stats.executed} failed=${stats.failed} pending=${stats.pending}`,
  );
  check(
    "getStats.by_action is a per-action breakdown object",
    typeof stats.by_action === "object" && stats.by_action !== null,
    JSON.stringify(Object.keys(stats.by_action).slice(0, 4)),
  );

  // ── moderation.getCoverage (used to read the deleted ai_analysis_runs) ──
  const coverage = await moderationRepository.getCoverage(30);
  check("getCoverage total is non-zero", coverage.total > 0, `total=${coverage.total}`);
  check("getCoverage completed is non-zero", coverage.completed > 0, `completed=${coverage.completed}`);
  check(
    "getCoverage exposes per-outcome counts",
    coverage.outcomes && typeof coverage.outcomes === "object",
    JSON.stringify(coverage.outcomes),
  );
  check(
    "coverage_rate is a sane percentage",
    coverage.coverage_rate > 0 && coverage.coverage_rate <= 100,
    `${coverage.coverage_rate}%`,
  );

  // ── moderation.getQueueStats (new) ──────────────────────────────────────
  const queue = await moderationRepository.getQueueStats();
  check(
    "getQueueStats uses the new pipeline vocabulary",
    Object.keys(queue.by_status).every((s) =>
      ["pending", "claimed", "analyzed", "retry_wait", "dead"].includes(s),
    ),
    JSON.stringify(queue.by_status),
  );

  // ── messages.getReviewMessages (returned 0 rows before) ─────────────────
  // Now cursor-paged: it returns `{ results, nextCursor }`, not a bare array.
  const review = await messagesRepository.getReviewMessages(undefined, 10);
  check("getReviewMessages returns rows", review.results.length > 0, `${review.results.length} rows`);
  check(
    "every review row has a verdict_status or is dead",
    review.results.every((r) => r.verdict_status !== null || r.ai_status === "dead"),
  );
  check(
    "review rows carry the joined verdict detail",
    review.results.some((r) => r.verdict_recommended_action !== null || r.verdict_status !== null),
  );

  // ── messages.findById: verdict joined, plus attempt history ─────────────
  const sample = await getDatabase()
    .execute(
      `SELECT message_id FROM verdicts WHERE status = 'deleted' ORDER BY updated_at DESC LIMIT 1`,
    );
  const sampleId = sample.rows[0]?.message_id;
  check("found a deleted message to inspect", Boolean(sampleId), String(sampleId));

  if (sampleId) {
    const msg = await messagesRepository.findById(sampleId);
    check("findById returns the message", Boolean(msg));
    check("findById joins the verdict", msg?.verdict_status === "deleted", `verdict_status=${msg?.verdict_status}`);
    check("findById exposes pipeline status", Boolean(msg?.ai_status), `ai_status=${msg?.ai_status}`);
    check("findById exposes retry bookkeeping", typeof msg?.ai_attempts === "number", `attempts=${msg?.ai_attempts}`);

    const attempts = await messagesRepository.getAnalysisAttempts(sampleId);
    check("getAnalysisAttempts returns history", attempts.length > 0, `${attempts.length} attempts`);
    check(
      "attempts are ordered oldest first with valid outcomes",
      attempts.every((a, i) => i === 0 || attempts[i - 1].created_at <= a.created_at) &&
        attempts.every((a) => ["success", "llm_error", "parse_error", "abandoned", "duplicate"].includes(a.outcome)),
      attempts.map((a) => `#${a.attempt}:${a.outcome}`).join(" "),
    );
  }

  // ── findById must still work for a message with NO verdict (left join) ──
  const unjudged = await getDatabase().execute(
    `SELECT m.id FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
     WHERE v.message_id IS NULL AND m.ai_status = 'analyzed' LIMIT 1`,
  );
  if (unjudged.rows[0]?.id) {
    const msg = await messagesRepository.findById(unjudged.rows[0].id);
    check(
      "findById still returns unjudged messages (LEFT JOIN, not INNER)",
      Boolean(msg) && msg.verdict_status === null,
      `verdict_status=${msg?.verdict_status}`,
    );
  }

  // ── dashboard: the headline counters that were permanently zero ─────────
  const dash = await dashboardRepository.getStats();
  check("dashboard total_flagged is live", dash.total_flagged > 0, `flagged=${dash.total_flagged}`);
  check("dashboard total_clean is live", dash.total_clean > 0, `clean=${dash.total_clean}`);
  check("dashboard total_warned is live", dash.total_warned > 0, `warn=${dash.total_warned}`);
  check("dashboard still counts total messages", dash.total_messages > 0, `messages=${dash.total_messages}`);

  const activity = await dashboardRepository.getActivity(7);
  check("dashboard activity returns daily buckets", activity.daily.length > 0, `${activity.daily.length} days`);
  check(
    "daily buckets carry real message counts",
    activity.daily.some((d) => d.messages > 0),
  );
  check("hourly buckets return", activity.hourly.length > 0, `${activity.hourly.length} hours`);

  const users = await dashboardRepository.listUsers({ limit: 5 });
  const userRows = users.data ?? users;
  check("dashboard listUsers returns rows", userRows.length > 0, `${userRows.length} users`);
  check(
    "user rows carry live verdict counts",
    userRows.some((u) => Number(u.clean_count) > 0 || Number(u.flagged_count) > 0),
  );

  await closeDatabase();
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
} finally {
  await new pg.Pool({ connectionString: dsn, max: 1 }).end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
