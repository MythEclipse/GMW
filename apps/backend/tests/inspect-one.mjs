/**
 * One message, end to end: verdict, enforcer state, delete attempts, and
 * Discord's own answer for it.
 *
 * Usage: DSN=<prod dsn> bun tests/inspect-one.mjs <messageId>
 */
import { execSync } from "node:child_process";
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
const id = process.argv[2];
if (!id) {
  console.error("message id required");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  const row = await pool.query(
    `SELECT m.id, m.guild_id, m.channel_id, m.user_id, m.username, m.content,
            m.ai_status, m.deleted_at, m.created_at,
            v.status AS verdict_status, v.confidence, v.score,
            v.recommended_action, v.flags, v.categories, v.analysis, v.model,
            v.auto_delete_state, v.auto_delete_claimed_at, v.created_at AS v_at
     FROM messages m
     LEFT JOIN verdicts v ON v.message_id = m.id
     WHERE m.id = $1`,
    [id],
  );
  if (row.rows.length === 0) {
    console.log("NOT FOUND in messages");
  }
  for (const r of row.rows) {
    console.log(`id            ${r.id}`);
    console.log(`author        ${r.username} (${r.user_id})`);
    console.log(`content       ${JSON.stringify(r.content)}`);
    console.log(`guild         ${r.guild_id}`);
    console.log(`channel       ${r.channel_id}`);
    console.log(`ai_status     ${r.ai_status}`);
    console.log(`deleted_at    ${r.deleted_at ?? "(still present)"}`);
    console.log(`verdict       ${r.verdict_status} / conf=${r.confidence} / score=${r.score}`);
    console.log(`action        ${r.recommended_action}`);
    console.log(`categories    ${JSON.stringify(r.categories)}`);
    console.log(`flags         ${JSON.stringify(r.flags)}`);
    console.log(`model         ${r.model}`);
    console.log(`analysis      ${String(r.analysis ?? "").slice(0, 300)}`);
    console.log(`auto_delete   ${r.auto_delete_state ?? "(null)"} claimed_at=${r.auto_delete_claimed_at ?? "-"}`);
  }

  const acts = await pool.query(
    `SELECT action_type, reason, status, error, executed_by, created_at
     FROM moderation_actions WHERE message_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [id],
  );
  console.log(`\nmoderation_actions (${acts.rows.length}):`);
  for (const a of acts.rows) {
    const age = Math.round((Date.now() - Number(a.created_at)) / 60000);
    console.log(
      `   ${a.action_type} reason=${a.reason} status=${a.status} by=${a.executed_by} ${age}m ago err=${a.error ? String(a.error).slice(0, 80) : "-"}`,
    );
  }

  console.log("\ngateway journal:");
  try {
    const out = execSync(
      "sudo -n journalctl -u gmw-discord-gateway --since \"-6h\" -o cat --no-pager",
      { maxBuffer: 60 * 1024 * 1024 },
    ).toString();
    let n = 0;
    for (const line of out.split("\n")) {
      if (!line.includes(id)) continue;
      n++;
      if (n > 24) continue;
      console.log(`   ${line.slice(0, 300)}`);
    }
    if (n === 0) console.log("   (no line mentions this id)");
  } catch (e) {
    console.log(`   (journal unavailable: ${e.message.slice(0, 70)})`);
  }
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await pool.end();
}
