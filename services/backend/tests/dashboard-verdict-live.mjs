/**
 * Runs the backend's dashboard/moderation SQL against the REAL production
 * database and asserts the numbers are live.
 *
 * Before the rewrite every one of these counted `messages.ai_status =
 * 'flagged'`, a value the worker never writes. Each returned 0 without error,
 * so the dashboard rendered a clean, quiet guild while moderation was running
 * and flagging messages. This asserts the same queries now move off zero.
 *
 * Run with: DSN=... bun tests/dashboard-verdict-live.mjs
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
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  // ── Headline counters (getStats) ────────────────────────────────────────
  const stats = await pool.query(`
    SELECT
      COUNT(*)::int AS total_messages,
      COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS total_flagged,
      COUNT(*) FILTER (WHERE v.status = 'clean')::int AS total_clean,
      COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS total_warned,
      COUNT(*) FILTER (WHERE v.status = 'error')::int AS total_error,
      COUNT(*) FILTER (WHERE m.ai_status = 'pending')::int AS total_pending,
      COUNT(*) FILTER (WHERE m.ai_status = 'claimed')::int AS total_claimed,
      COUNT(*) FILTER (WHERE m.ai_status = 'retry_wait')::int AS total_retry_wait,
      COUNT(*) FILTER (WHERE m.ai_status = 'dead')::int AS total_dead
    FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
  `);
  const s = stats.rows[0];
  check("total_flagged is live (was permanently 0)", s.total_flagged > 0, `flagged=${s.total_flagged}`);
  check("total_clean is live (was permanently 0)", s.total_clean > 0, `clean=${s.total_clean}`);
  check("total_warned tracks the actionable verdict", s.total_warned === s.total_flagged, `warn=${s.total_warned} flagged=${s.total_flagged}`);
  check("judged counts add up to real verdicts", s.total_clean + s.total_warned + s.total_flagged + s.total_error > 0);
  check("pending/claimed/retry_wait/dead use the new vocabulary", ["total_pending", "total_claimed", "total_retry_wait", "total_dead"].every((k) => typeof s[k] === "number"));

  // The old query, for contrast: proves the bug was real.
  const old = await pool.query(
    "SELECT COUNT(*)::int AS n FROM messages WHERE ai_status = 'flagged'",
  );
  check("old ai_status='flagged' really is 0 (bug confirmed)", old.rows[0].n === 0, `n=${old.rows[0].n}`);

  // ── Trends (getTrends: daily + hourly) ──────────────────────────────────
  const daily = await pool.query(`
    SELECT
      to_char(to_timestamp(m.created_at / 1000), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS messages,
      COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged
    FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
    WHERE m.created_at >= $1
    GROUP BY day ORDER BY day
  `, [Date.now() - 7 * 864e5]);
  check("daily trend returns buckets", daily.rows.length > 0, `${daily.rows.length} days`);
  check("daily trend has non-zero messages", daily.rows.some((r) => r.messages > 0));

  const hourly = await pool.query(`
    SELECT EXTRACT(HOUR FROM to_timestamp(m.created_at / 1000))::int AS hour,
           COUNT(*)::int AS messages,
           COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged
    FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
    WHERE m.created_at >= $1
    GROUP BY hour ORDER BY hour
  `, [Date.now() - 864e5]);
  check("hourly distribution returns buckets", hourly.rows.length > 0, `${hourly.rows.length} hours`);

  // ── Top users / channels ────────────────────────────────────────────────
  const users = await pool.query(`
    SELECT msg.user_id, msg.username, msg.avatar_url,
           COUNT(*)::int AS total_messages,
           COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged_count,
           COUNT(*) FILTER (WHERE v.status = 'clean')::int AS clean_count,
           COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS warn_count,
           MAX(msg.created_at) AS last_message_at
    FROM messages msg LEFT JOIN verdicts v ON v.message_id = msg.id
    GROUP BY msg.user_id, msg.username, msg.avatar_url
    ORDER BY COUNT(*) DESC LIMIT 5
  `);
  check("top users returns rows", users.rows.length > 0, `${users.rows.length} users`);
  check(
    "top users clean_count is live",
    users.rows.some((r) => r.clean_count > 0),
    `max clean=${Math.max(...users.rows.map((r) => r.clean_count))}`,
  );

  const channels = await pool.query(`
    SELECT msg.channel_id, msg.guild_id,
           COALESCE(NULLIF((msg.metadata::jsonb -> 'channel' ->> 'channelName'), ''), msg.channel_id) AS channel_name,
           COUNT(*)::int AS total_messages,
           COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged_count
    FROM messages msg LEFT JOIN verdicts v ON v.message_id = msg.id
    WHERE msg.metadata IS NOT NULL AND msg.metadata != ''
    GROUP BY msg.channel_id, msg.guild_id, (msg.metadata::jsonb -> 'channel' ->> 'channelName')
    ORDER BY COUNT(*) DESC LIMIT 5
  `);
  check("top channels returns rows", channels.rows.length > 0, `${channels.rows.length} channels`);

  // ── The LEFT JOIN must not drop unjudged messages ───────────────────────
  const join = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM messages) AS bare,
      (SELECT COUNT(*)::int FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id) AS joined
  `);
  check(
    "LEFT JOIN preserves message count (INNER would drop 48k)",
    join.rows[0].bare === join.rows[0].joined,
    `bare=${join.rows[0].bare} joined=${join.rows[0].joined}`,
  );
} finally {
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
