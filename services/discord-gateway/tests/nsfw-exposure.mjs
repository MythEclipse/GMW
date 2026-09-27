/**
 * How many messages would the NSFW skip actually protect in production?
 *
 * The skip is verified by unit test against the dev database, but the
 * question that matters operationally is how much live data is currently
 * exposed to being moderated and deleted in NSFW channels. If that number
 * is large, the skip is not cosmetic.
 *
 * Run: DSN=<prod dsn> bun tests/nsfw-exposure.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  const res = await pool.query(`
    WITH nsfw_ch AS (
      SELECT DISTINCT channel_id
      FROM messages
      WHERE (metadata::jsonb -> 'channel' ->> 'nsfw') = 'true'
    )
    SELECT
      (SELECT count(DISTINCT channel_id) FROM nsfw_ch) AS nsfw_channels,
      (SELECT count(*)::int FROM messages m
         JOIN nsfw_ch c ON c.channel_id = m.channel_id
        WHERE m.deleted_at IS NULL) AS live_nsfw_messages,
      (SELECT count(*)::int FROM verdicts v
         JOIN messages m ON m.id = v.message_id
         JOIN nsfw_ch c ON c.channel_id = m.channel_id
        WHERE v.status IN ('flagged','warn') AND m.deleted_at IS NULL
      ) AS undecided_flagged_or_warn,
      (SELECT count(*)::int FROM verdicts v
         JOIN messages m ON m.id = v.message_id
         JOIN nsfw_ch c ON c.channel_id = m.channel_id
        WHERE v.status IN ('flagged','warn') AND m.deleted_at IS NULL
          AND (v.auto_delete_state IS NULL OR v.auto_delete_state = 'pending')
      ) AS still_claimable_by_enforcer
  `);
  const r = res.rows[0];
  console.log("NSFW exposure in production:");
  console.log(`  nsfw channels              ${r.nsfw_channels}`);
  console.log(`  live messages in them      ${r.live_nsfw_messages}`);
  console.log(`  flagged/warn verdicts      ${r.undecided_flagged_or_warn}`);
  console.log(`  claimable by enforcer      ${r.still_claimable_by_enforcer}`);

  // The enforcer's own predicate, verbatim, so the number above is what the
  // code would actually pick up rather than a paraphrase of it.
  const claimable = await pool.query(`
    WITH candidates AS (
      SELECT v.message_id
      FROM verdicts v
      JOIN messages m ON m.id = v.message_id
      WHERE v.status IN ('flagged', 'warn')
        AND m.deleted_at IS NULL
        AND (v.auto_delete_state IS NULL OR v.auto_delete_state = 'pending')
        AND COALESCE((m.metadata::jsonb -> 'channel' ->> 'nsfw')::boolean, false) = false
      ORDER BY v.created_at ASC
      LIMIT 1000
    )
    SELECT count(*)::int AS would_claim FROM candidates`);
  console.log(
    `\n  enforcer would claim (first 1000): ${claimable.rows[0].would_claim}`,
  );
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await pool.end();
}
