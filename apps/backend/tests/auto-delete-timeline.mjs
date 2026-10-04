/**
 * When did auto-delete actually stop, and is it coming back?
 *
 * The rewrite (2658b0dd) deleted ai-moderation/autoDeleteManager.ts (562 lines)
 * along with autoDeleteEligibility/autoDeleteLogger/autoDeleteNotify. Nothing
 * in the current tree calls publishCommand*, so the gateway's delete handler is
 * unreachable. This measures the timeline from the data:
 *
 *   - the last delete_message row (should be at the restart, not "now")
 *   - whether any row exists after the restart timestamp
 *   - how many flagged messages are piling up un-enforced
 *
 * The restart time is passed in so the window is measured against the real
 * process start rather than a guess.
 *
 * Run: DSN=<prod dsn> bun tests/auto-delete-timeline.mjs [restartEpochMs]
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}

// Fall back to the gateway's start time from systemd when not supplied.
let restartMs = Number(process.argv[2]);
if (!Number.isFinite(restartMs)) {
  // systemctl prints "Sun 2026-09-27 19:13:56 WIB", which Date.parse rejects
  // (WIB is not a TZ token it knows). journalctl emits proper ISO 8601, so read
  // the unit's first line instead and take the newest timestamp.
  const { execSync } = await import("node:child_process");
  const out = execSync(
    "sudo -n journalctl -u gmw-discord-gateway -o short-iso --no-pager | tail -1",
  )
    .toString()
    .trim();
  const stamp = out.split(" ")[0];
  restartMs = Date.parse(stamp);
  if (!Number.isFinite(restartMs)) {
    console.log("could not parse restart time from:", JSON.stringify(out));
    process.exit(2);
  }
}
console.log("gateway restarted at:", new Date(restartMs).toISOString());

const pool = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  const last = await pool.query(`
    SELECT max(created_at) AS newest,
           count(*) FILTER (WHERE created_at > $1)::int AS after_restart
    FROM moderation_actions
    WHERE action_type = 'delete_message'`, [restartMs]);
  const l = last.rows[0];
  const newestAge = l.newest
    ? Math.round((Date.now() - Number(l.newest)) / 3600000)
    : null;
  console.log(
    `last delete_message: ${l.newest ? new Date(Number(l.newest)).toISOString() : "never"}` +
      (newestAge === null ? "" : ` (${newestAge}h ago)`),
  );
  console.log("delete_message rows since restart:", l.after_restart);

  // Which auto-delete logger names still appear, and when each last fired.
  const loggers = await pool.query(`
    SELECT COALESCE(executed_by, '(null)') AS who,
           action_type,
           count(*)::int AS n,
           max(created_at) AS newest
    FROM moderation_actions
    GROUP BY 1, 2
    ORDER BY 4 DESC
    LIMIT 10`);
  console.log("\nlast write per (executed_by, action_type):");
  for (const r of loggers.rows) {
    const age = Math.round((Date.now() - Number(r.newest)) / 3600000);
    const after = Number(r.newest) > restartMs ? "  <-- AFTER RESTART" : "";
    console.log(
      `   ${r.who.padEnd(20)} ${r.action_type.padEnd(16)} n=${String(r.n).padEnd(5)} ${age}h ago${after}`,
    );
  }

  // Is enforcement backlog growing? flagged verdicts, still present.
  const backlog = await pool.query(`
    SELECT
      count(*) FILTER (WHERE m.deleted_at IS NULL)::int AS present,
      count(*)::int AS total
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE v.status = 'deleted'`);
  const b = backlog.rows[0];
  const pct = b.total ? ((b.present / b.total) * 100).toFixed(1) : "0";
  console.log(
    `\nflagged verdicts: ${b.present}/${b.total} still present (${pct}%)`,
  );

  // And the decisive one: has the gateway deleted anything at all recently?
  const fresh = await pool.query(`
    SELECT count(*)::int AS n
    FROM messages
    WHERE deleted_at > $1`, [restartMs]);
  console.log(
    "messages.deleted_at since restart:",
    fresh.rows[0].n,
    "(0 = the gateway has deleted nothing at all since the rewrite)",
  );
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await pool.end();
}
