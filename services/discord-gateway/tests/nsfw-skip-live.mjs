/**
 * Prove the NSFW skip is live, by queueing a message into a real NSFW
 * channel and confirming the worker leaves it alone.
 *
 * The unit tests cover the gate. This covers the deployed process: it
 * inserts a pending message into one of the guild's actual NSFW
 * channels, lets the running gateway's worker claim it, and asserts the
 * row comes back with no verdict and no LLM call.
 *
 * Run: DSN=<prod dsn> bun tests/nsfw-skip-live.mjs
 */
import { execSync } from "node:child_process";
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: dsn, max: 1 });
const ID = `nsfw-skip-live-${Date.now()}`;

try {
  // A channel Discord actually marks NSFW, taken from stored metadata.
  const ch = await pool.query(`
    SELECT channel_id, count(*)::int AS n
    FROM messages
    WHERE (metadata::jsonb -> 'channel' ->> 'nsfw') = 'true'
    GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  if (ch.rows.length === 0) {
    console.log("no NSFW channel found in stored data — cannot test");
    process.exit(0);
  }
  const channelId = ch.rows[0].channel_id;
  console.log(`NSFW channel: ${channelId} (${ch.rows[0].n} real messages)`);

  // A peer message, so the insert is not the only candidate.
  const peerId = `${ID}-peer`;

  const meta = (nsfw) =>
    JSON.stringify({
      stickers: [], embeds: [], attachments: [], customEmojis: [],
      mentionedRoles: [], mentionedUsers: [],
      author: { id: "u", username: "u", tag: "u", bot: false },
      member: { displayName: "U", roles: [] },
      channel: {
        nsfw, topic: null, threadId: null, channelId,
        nsfwLevel: null, threadName: null, channelName: "c", ageRestricted: nsfw,
      },
      reference: null, isCrosspost: false,
    });

  for (const [id, nsfw] of [[ID, true], [peerId, false]]) {
    await pool.query(
      `INSERT INTO messages
         (id, guild_id, channel_id, user_id, username, content,
          created_at, ai_status, ready_for_work_at, metadata)
       VALUES ($1,'g',$2,'u','live-probe','probe body',$3,'pending',0,$4)`,
      [id, channelId, Date.now(), meta(nsfw)],
    );
  }
  console.log(`seeded ${ID} (nsfw) and ${peerId} (safe)`);

  // Give the running worker time to claim a batch.
  await new Promise((r) => setTimeout(r, 25_000));

  const res = await pool.query(
    `SELECT id, ai_status, worker_id,
            (metadata::jsonb -> 'channel' ->> 'nsfw')::boolean AS nsfw
     FROM messages WHERE id = ANY($1)`,
    [[ID, peerId]],
  );
  const verdicts = await pool.query(
    `SELECT message_id FROM verdicts WHERE message_id = ANY($1)`,
    [[ID, peerId]],
  );
  const judged = new Set(verdicts.rows.map((r) => r.message_id));

  console.log("\nresult:");
  for (const r of res.rows) {
    console.log(
      `   ${r.id.padEnd(38)} nsfw=${String(r.nsfw).padEnd(5)} status=${String(r.ai_status).padEnd(10)} judged=${judged.has(r.id)}`,
    );
  }

  const nsfwRow = res.rows.find((r) => r.id === ID);
  const safeRow = res.rows.find((r) => r.id === peerId);
  const nsfwSkipped =
    nsfwRow &&
    !judged.has(ID) &&
    ["pending", "analyzed"].includes(nsfwRow.ai_status) &&
    nsfwRow.worker_id === null;
  const safeHandled = safeRow && safeRow.ai_status !== "pending";

  console.log(
    `\n${nsfwSkipped ? "PASS" : "FAIL"}  NSFW message was not judged by the model`,
  );
  console.log(
    `${safeHandled ? "PASS" : "FAIL"}  safe message in the same batch was processed`,
  );

  // Clean up the probe rows (one statement per query — pg cannot send
  // multiple commands through a prepared statement).
  await pool.query("DELETE FROM verdicts WHERE message_id = ANY($1)", [
    [ID, peerId],
  ]);
  await pool.query("DELETE FROM analysis_attempts WHERE message_id = ANY($1)", [
    [ID, peerId],
  ]);
  await pool.query("DELETE FROM messages WHERE id = ANY($1)", [[ID, peerId]]);
  console.log("\ncleaned up probe rows");

  process.exit(nsfwSkipped && safeHandled ? 0 : 1);
} catch (e) {
  console.log("ERR", e.message);
  process.exit(1);
} finally {
  await pool.end();
}
