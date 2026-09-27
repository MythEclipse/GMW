/**
 * Does auto-delete actually happen?
 *
 * The rewrite left the config (AUTO_DELETE_FLAGGED_*), the gateway command
 * handler and the `auto_deleted` column in place, but nothing calls
 * publishCommand* — so the handler is unreachable. This proves it from the
 * database instead of from grep: a message the bot deleted leaves
 * messages.deleted_at set, so flagged-but-present rows are messages that were
 * judged and never removed.
 *
 * Run: DSN=<prod dsn> bun tests/auto-delete-reality.mjs
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

const pool = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  const flagged = await pool.query(`
    SELECT
      count(*)::int AS flagged,
      count(*) FILTER (WHERE m.deleted_at IS NOT NULL)::int AS deleted,
      count(*) FILTER (WHERE m.deleted_at IS NULL)::int AS present
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE v.status = 'flagged'`);
  const f = flagged.rows[0];
  console.log(
    `flagged verdicts: ${f.flagged} (deleted ${f.deleted}, still present ${f.present})`,
  );
  check(
    "flagged messages that were auto-deleted exist",
    f.deleted > 0,
    `deleted=${f.deleted}`,
  );

  // Anything flagged in the last hours, and is it still up?
  const recent = await pool.query(`
    SELECT
      count(*)::int AS flagged,
      count(*) FILTER (WHERE m.deleted_at IS NULL)::int AS present
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE v.status = 'flagged' AND v.created_at > extract(epoch from now())::bigint * 1000 - 86400000`);
  const r = recent.rows[0];
  console.log(`flagged in last 24h: ${r.flagged} (still present ${r.present})`);
  check(
    "recent flagged messages are being removed",
    r.flagged === 0 || r.present === 0,
    r.flagged === 0
      ? "nothing flagged in 24h — nothing to delete"
      : `${r.present}/${r.flagged} flagged messages still present after 24h`,
  );

  // The legacy log the old auto-delete wrote to. Frozen => no new enforcement.
  const legacy = await pool.query(`
    SELECT count(*)::int AS n, max(created_at) AS newest
    FROM moderation_actions`);
  const l = legacy.rows[0];
  const days = l.newest
    ? Math.round((Date.now() - Number(l.newest)) / 86400000)
    : null;
  console.log(
    `moderation_actions: ${l.n} rows, newest ${l.newest ? `${l.newest} (${days}d ago)` : "n/a"}`,
  );
  check(
    "the legacy enforcement log has not been written since the rewrite",
    days === null || days > 1,
    days === null ? "empty" : `newest entry is ${days} days old`,
  );

  // verdicts is the live source: is it advancing?
  const live = await pool.query(`
    SELECT count(*)::int AS n, max(created_at) AS newest
    FROM verdicts`);
  const v = live.rows[0];
  const vDays = v.newest
    ? Math.round((Date.now() - Number(v.newest)) / 86400000)
    : null;
  console.log(
    `verdicts: ${v.n} rows, newest ${v.newest ? `${vDays}d ago` : "n/a"}`,
  );
  check(
    "verdicts is still being written (judging is live)",
    vDays === null || vDays <= 1,
    vDays === null ? "empty" : `newest verdict ${vDays}d ago`,
  );
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
