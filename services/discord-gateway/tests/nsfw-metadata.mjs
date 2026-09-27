/**
 * Does messages.metadata actually carry the nsfw flag in production?
 *
 * The Discord side is confirmed: messageMetadata.ts already reads
 * `safetyChannel.nsfw` (typed as boolean on GuildTextChannel /
 * GuildVoiceChannel) and puts it in the metadata object. This checks
 * whether that metadata is persisted into messages.metadata, and what
 * the value actually is for real messages — so the NSFW skip is built
 * on observed data rather than an assumed column.
 *
 * Run: DSN=<prod dsn> bun tests/nsfw-metadata.mjs
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
  // 1. Is the flag present at all?
  const shape = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE metadata::jsonb -> 'channel' ? 'nsfw')::int AS with_nsfw_key,
      count(*) FILTER (WHERE metadata::jsonb -> 'channel' ->> 'nsfw' = 'true')::int AS nsfw_true,
      count(*) FILTER (WHERE metadata::jsonb -> 'channel' ->> 'nsfw' = 'false')::int AS nsfw_false
    FROM messages
    WHERE metadata IS NOT NULL AND metadata <> ''
    ORDER BY count(*) DESC
    LIMIT 1`);
  const s = shape.rows[0];
  console.log("messages.metadata nsfw key:", JSON.stringify(s));
  check("metadata is populated at all", s.total > 0, `${s.total} rows`);
  check(
    "the nsfw key is present in stored metadata",
    s.with_nsfw_key > 0,
    `${s.with_nsfw_key}/${s.total} rows carry it`,
  );

  // 2. What does it look like on a real row?
  const sample = await pool.query(`
    SELECT m.id, m.channel_id, m.username,
           m.metadata::jsonb -> 'channel' -> 'nsfw' AS nsfw,
           m.metadata::jsonb -> 'channel' ->> 'nsfwLevel' AS nsfw_level,
           left(m.content, 40) AS content
    FROM messages m
    WHERE m.metadata IS NOT NULL AND m.metadata::jsonb -> 'channel' ? 'nsfw'
    ORDER BY m.created_at DESC
    LIMIT 8`);
  console.log("\nrecent rows carrying the key:");
  for (const r of sample.rows) {
    console.log(
      `   ${r.id} ch=${r.channel_id} nsfw=${JSON.stringify(r.nsfw)} level=${JSON.stringify(r.nsfw_level)} user=${r.username}`,
    );
  }

  // 3. Are there distinct channel nsfw values? If every row is false there is
  // nothing to skip and the feature would be a no-op.
  const channels = await pool.query(`
    SELECT channel_id,
           bool_or(metadata::jsonb -> 'channel' ->> 'nsfw' = 'true')  AS any_nsfw,
           bool_or(metadata::jsonb -> 'channel' ->> 'nsfw' = 'false') AS any_safe,
           count(*)::int AS n
    FROM messages
    WHERE metadata IS NOT NULL AND metadata::jsonb -> 'channel' ? 'nsfw'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 10`);
  console.log("\nchannels by nsfw flag:");
  for (const c of channels.rows) {
    console.log(
      `   ${c.channel_id}  n=${String(c.n).padEnd(6)} any_nsfw=${c.any_nsfw} any_safe=${c.any_safe}`,
    );
  }
  const flagged = channels.rows.filter((c) => c.any_nsfw);
  check(
    "at least one channel is actually flagged nsfw in stored data",
    flagged.length > 0,
    flagged.length > 0
      ? `${flagged.length} channel(s): ${flagged.map((c) => c.channel_id).join(", ")}`
      : "none — a skip on this flag would never fire",
  );
  check(
    "the flag is discriminating (not constant across channels)",
    channels.rows.some((c) => c.any_nsfw) &&
      channels.rows.some((c) => !c.any_nsfw),
    `${channels.rows.filter((c) => !c.any_nsfw).length} safe channel(s) vs ${flagged.length} nsfw`,
  );
} catch (e) {
  fail++;
  console.log("FAIL  threw —", e.message);
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
