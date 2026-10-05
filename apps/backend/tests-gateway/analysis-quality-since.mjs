/**
 * Did the analysis-quality change actually take effect in production?
 *
 * The corpus-wide boilerplate rate is dominated by old rows, so it barely
 * moves on deploy. What matters is the rate of analyses written AFTER the
 * worker picked up the new prompt. This reads the worker's start time from
 * its journal and slices the corpus on it, so the number reflects live
 * behaviour rather than history.
 *
 * Run: DSN=<prod dsn> bun tests/analysis-quality-since.mjs
 */
import { execSync } from "node:child_process";
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}

const BOILERPLATE = [
  "tidak mengandung unsur pelanggaran",
  "tidak ada indikasi pelanggaran",
  "tidak melanggar kebijakan",
  "tidak mengandung pelanggaran",
  "tidak ada pelanggaran",
  "tidak menunjukkan tanda-tanda",
  "tidak menunjukkan pelanggaran",
  "nihil",
  "bersih dari pelanggaran",
];
const RE = BOILERPLATE.join("|");

// The worker's start time — everything older predates the new prompt.
let since = 0;
try {
  // The LAST start, not the first: only the most recent restart can have
  // picked up the new prompt. Reading the first one silently measures the
  // old code and reports a rate that never improves.
  const out = execSync(
    'sudo -n journalctl -u gmw-backend --since "-12h" -o short-iso --no-pager | grep "Starting GMW" | tail -1',
    { encoding: "utf8" },
  ).trim();
  const m = out.match(/^(\d{4}-\d{2}-\d{2}T[\d:]+[+\-]\d{2}:\d{2})/);
  if (m) since = new Date(m[1]).getTime();
} catch {
  /* fall through */
}

const pool = new pg.Pool({ connectionString: dsn, max: 1 });
try {
  if (since === 0) {
    console.log("could not read worker start time; showing last 30 min instead");
    since = Date.now() - 30 * 60_000;
  }
  console.log(`worker restarted: ${new Date(since).toISOString()}`);

  const r = await pool.query(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE lower(analysis) ~ $2)::int AS boilerplate
    FROM verdicts
    WHERE created_at >= $1 AND analysis IS NOT NULL AND analysis <> ''
  `,
    [since, `(${RE})`],
  );
  const row = r.rows[0];
  const pct = row.total > 0 ? ((row.boilerplate / row.total) * 100).toFixed(1) : "n/a";
  console.log(`\nsince restart: ${row.total} analyses, ${row.boilerplate} boilerplate = ${pct}%`);
  console.log(`(corpus-wide historical rate: 26.2%)`);

  console.log("\n=== every analysis written since the restart ===");
  const all = await pool.query(
    `
    SELECT v.status, left(v.analysis, 200) AS analysis, left(m.content, 45) AS content,
           (SELECT count(*)::int FROM attachments a WHERE a.message_id = m.id) AS n_attach
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE v.created_at >= $1 AND v.analysis IS NOT NULL AND v.analysis <> ''
    ORDER BY v.created_at DESC
    LIMIT 25
  `,
    [since],
  );
  for (const x of all.rows) {
    const kind = x.n_attach > 0 ? "img" : "txt";
    console.log(`\n  [${kind}] ${x.status}: ${JSON.stringify((x.content ?? "").slice(0, 45))}`);
    console.log(`     ${x.analysis}`);
  }
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await pool.end();
}
