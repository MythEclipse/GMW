/**
 * What did the revived enforcer actually do in its first minutes?
 *
 * The gateway logs every decision but not its outcome counts, and
 * messages.deleted_at is only set when the gateway's own messageDelete event
 * handler runs — which it does, so a real delete should show up there. This
 * reads the audit log the enforcer writes (moderation_actions, executed_by =
 * 'auto-delete-manager') and joins it to messages.deleted_at.
 *
 * Run: DSN=<prod dsn> bun tests/auto-delete-outcome.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  const recent = await pool.query(`
    SELECT a.status, count(*)::int AS n,
           max(a.created_at) AS newest,
           count(*) FILTER (WHERE m.deleted_at IS NOT NULL)::int AS msg_deleted,
           count(*) FILTER (WHERE m.deleted_at IS NULL)::int AS msg_present
    FROM moderation_actions a
    LEFT JOIN messages m ON m.id = a.message_id
    WHERE a.executed_by = 'auto-delete-manager'
      AND a.created_at > extract(epoch from now())::bigint * 1000 - 7200000
    GROUP BY 1 ORDER BY 2 DESC`);
  console.log("auto-delete-manager, last 2h, by status:");
  for (const r of recent.rows) {
    const age = Math.round((Date.now() - Number(r.newest)) / 60000);
    console.log(
      `   status=${r.status.padEnd(9)} n=${String(r.n).padEnd(5)} msg_deleted=${String(r.msg_deleted).padEnd(5)} msg_present=${String(r.msg_present).padEnd(5)} newest=${age}m ago`,
    );
  }

  // The reason column is what the manager recorded for each attempt.
  const reasons = await pool.query(`
    SELECT reason, status, count(*)::int AS n
    FROM moderation_actions
    WHERE executed_by = 'auto-delete-manager'
      AND created_at > extract(epoch from now())::bigint * 1000 - 7200000
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`);
  console.log("\nreasons recorded in the last 2h:");
  for (const r of reasons.rows) {
    console.log(`   ${String(r.reason).slice(0, 42).padEnd(42)} ${r.status.padEnd(9)} ${r.n}`);
  }

  // The enforcer's own sentinel: what has it decided so far?
  const states = await pool.query(`
    SELECT auto_delete_state, count(*)::int AS n
    FROM verdicts
    WHERE status = 'deleted'
    GROUP BY 1 ORDER BY 2 DESC`);
  console.log("\nenforcer state on flagged/warn verdicts:");
  for (const r of states.rows) {
    console.log(`   ${String(r.auto_delete_state).padEnd(10)} ${r.n}`);
  }

  // Messages the enforcer deleted from Discord since the restart.
  const gatewayDeletes = await pool.query(`
    SELECT count(*)::int AS n, max(deleted_at) AS newest
    FROM messages
    WHERE deleted_at > extract(epoch from now())::bigint * 1000 - 7200000`);
  console.log(
    "\nmessages.deleted_at in the last 2h:",
    JSON.stringify(gatewayDeletes.rows[0]),
  );
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await pool.end();
}
