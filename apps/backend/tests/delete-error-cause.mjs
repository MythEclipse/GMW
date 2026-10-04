/**
 * Is MESSAGE_ID_NOT_FOUND a real "not there", or a selfbot limitation?
 *
 * 13 deletes failed with that code. Two very different causes produce it:
 *   - the message really is gone (a human deleted it, or another bot), in
 *     which case treating it as "already deleted" is correct and it is not an
 *     error at all;
 *   - the selfbot cannot delete in that channel — Discord returns
 *     MESSAGE_ID_NOT_FOUND rather than 403 when the account lacks
 *     MANAGE_MESSAGES and the message is therefore not visible to it.
 *
 * Which one it is decides whether the fix is a code change or a permission
 * change, so this checks: does OUR capture see the message, and has our own
 * messageDelete handler already recorded it as gone?
 *
 * Run: DSN=<prod dsn> bun tests/delete-error-cause.mjs
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
  const errs = await pool.query(`
    SELECT a.message_id, a.created_at, m.channel_id, m.guild_id,
           m.username, m.content, m.deleted_at, m.ai_status
    FROM moderation_actions a
    JOIN messages m ON m.id = a.message_id
    WHERE a.executed_by = 'auto-delete-manager' AND a.reason = 'error'
    ORDER BY a.created_at DESC
    LIMIT 20`);

  console.log(`failed delete attempts: ${errs.rows.length}`);
  console.log("");

  // How our own capture saw each one.
  for (const r of errs.rows.slice(0, 8)) {
    console.log(
      `   ${r.message_id} ch=${r.channel_id} by=${r.username} deleted_at=${r.deleted_at ?? "NULL"} ai_status=${r.ai_status} content=${JSON.stringify((r.content ?? "").slice(0, 30))}`,
    );
  }

  const neverDeleted = errs.rows.filter((r) => r.deleted_at === null);
  console.log(
    `\nof those, deleted_at IS NULL for ${neverDeleted.length}/${errs.rows.length}`,
  );

  // Distinguishing test: are these messages ones WE captured (so we could see
  // them) that Discord now says it cannot find? If we captured the content,
  // the account had access at capture time, so a later MESSAGE_ID_NOT_FOUND
  // means the message was removed — by a human, by Discord's own retention,
  // or by another moderator.
  const weCaptured = errs.rows.filter((r) => r.content !== null);
  check(
    "we captured the content of the failing messages",
    weCaptured.length > 0,
    `${weCaptured.length}/${errs.rows.length} have content`,
  );

  const ourOwnHandlerSawThem = errs.rows.filter((r) => r.deleted_at !== null);
  // These rows are exactly what the MESSAGE_ID_NOT_FOUND fix addresses: they
  // are expected to be present in the historical data - that is the bug - so
  // this is a measurement, not a pass/fail on correctness.
  console.log(
    `   -> ${ourOwnHandlerSawThem.length} of these were already gone when the delete was attempted;` +
      ` with the fix they record as already_deleted/executed instead of error/failed`,
  );

  // Do the same failures cluster on one channel? That would mean a permission
  // problem rather than a race with other moderators.
  const byChannel = new Map();
  for (const r of errs.rows) {
    byChannel.set(r.channel_id, (byChannel.get(r.channel_id) ?? 0) + 1);
  }
  console.log("\nfailures by channel:");
  for (const [ch, n] of [...byChannel].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${ch}  ${n}`);
  }
  const totalCh = byChannel.size;
  check(
    "failures are not concentrated in a single channel",
    totalCh > 1,
    `${totalCh} distinct channels — a per-channel MANAGE_MESSAGES gap would show as 1`,
  );

  // And: is the same channel succeeding elsewhere?
  // moderation_actions carries no channel_id of its own - it lives on messages.
  const mixed = await pool.query(`
    SELECT m.channel_id,
           count(*) FILTER (WHERE a.status = 'executed')::int AS ok,
           count(*) FILTER (WHERE a.status = 'failed')::int AS bad
    FROM moderation_actions a
    JOIN messages m ON m.id = a.message_id
    WHERE a.executed_by = 'auto-delete-manager'
      AND a.action_type = 'delete_message'
      AND a.reason IN ('deleted', 'already_deleted')
    GROUP BY 1 ORDER BY ok DESC LIMIT 6`);
  console.log("\nsuccessful deletes by channel:");
  for (const r of mixed.rows) {
    console.log(`   ${r.channel_id}  executed=${r.ok}`);
  }
  check(
    "deletes succeed in at least one channel",
    mixed.rows.length > 0 && mixed.rows[0].ok > 0,
    mixed.rows[0] ? `top channel has ${mixed.rows[0].ok} executed` : "none",
  );
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
