/**
 * What do real analyses actually say, and do image messages have evidence?
 *
 * The complaint is that analyses read as boilerplate ("Pesan singkat yang
 * tidak mengandung unsur pelanggaran kebijakan server") instead of explaining
 * what the message or image actually says. Two separate questions:
 *
 *   1. Do messages with attachments get a media description in the prompt?
 *      If the description is missing, the model has nothing to describe and
 *      falls back to saying "no text".
 *   2. Do text-only analyses explain the content, or assert a verdict?
 *
 * Run: DSN=<prod dsn> bun tests/analysis-quality.mjs
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: dsn, max: 1 });

// Phrases that assert a conclusion without describing anything. Used to
// measure how much of the corpus is boilerplate rather than explanation.
const BOILERPLATE = [
  "tidak mengandung unsur pelanggaran",
  "tidak ada indikasi pelanggaran",
  "tidak melanggar kebijakan",
  "tidak mengandung pelanggaran",
  "nihil pelanggaran",
  "bersih dari pelanggaran",
  "tidak menunjukkan pelanggaran",
  "tidak ada pelanggaran",
  "no violation",
];

try {
  // ── 1. Recent analyses, verbatim ────────────────────────────────────
  console.log("=== 20 most recent analyses ===");
  const recent = await pool.query(`
    SELECT v.status, v.severity,
           left(v.analysis, 150) AS analysis,
           left(m.content, 45) AS content,
           (SELECT count(*)::int FROM attachments a WHERE a.message_id = m.id) AS n_attach,
           (m.metadata::jsonb -> 'channel' ->> 'nsfw')::boolean AS nsfw,
           m.id
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    ORDER BY v.created_at DESC
    LIMIT 20`);
  for (const r of recent.rows) {
    const attach = r.n_attach > 0 ? `img×${r.n_attach}` : "text";
    console.log(
      `\n  [${attach}${r.nsfw ? " NSFW" : ""}] ${r.status}/${r.severity}`,
    );
    console.log(`    content : ${JSON.stringify((r.content ?? "").slice(0, 45))}`);
    console.log(`    analysis: ${r.analysis ?? "(null)"}`);
  }

  // ── 2. How much of the corpus is boilerplate? ────────────────────────
  const boiler = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE lower(analysis) ~ '(${BOILERPLATE.join("|")})')::int
        AS boilerplate
    FROM verdicts
    WHERE analysis IS NOT NULL AND analysis <> ''`);
  const b = boiler.rows[0];
  const pct = b.total > 0 ? ((b.boilerplate / b.total) * 100).toFixed(1) : "0";
  console.log(
    `\n=== boilerplate rate: ${b.boilerplate}/${b.total} = ${pct}% ===`,
  );

  // Boilerplate rate for text vs image messages — this is the discriminator.
  const split = await pool.query(`
    SELECT
      CASE WHEN (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) > 0
           THEN 'has_image' ELSE 'text_only' END AS kind,
      count(*)::int AS total,
      count(*) FILTER (WHERE lower(v.analysis) ~ '(${BOILERPLATE.join("|")})')::int
        AS boilerplate
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE v.analysis IS NOT NULL AND v.analysis <> ''
    GROUP BY 1`);
  console.log("\nby kind:");
  for (const r of split.rows) {
    const p = r.total > 0 ? ((r.boilerplate / r.total) * 100).toFixed(1) : "0";
    console.log(
      `   ${r.kind.padEnd(10)} total=${String(r.total).padEnd(7)} boilerplate=${String(r.boilerplate).padEnd(7)} ${p}%`,
    );
  }

  // ── 3. Image messages whose analysis never mentions the image ────────
  const blind = await pool.query(`
    SELECT count(*)::int AS n
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
      AND v.analysis IS NOT NULL
      AND lower(v.analysis) NOT ~ '(gambar|image|foto|sketsa|meme|sticker|video|lampiran|visual|terlihat|menampilkan|deskripsi)'`);
  console.log(
    `\nimage messages whose analysis never references the image: ${blind.rows[0].n}`,
  );

  // ── 4. The two examples the user quoted, located ─────────────────────
  const quoted = await pool.query(`
    SELECT m.id, m.content, m.created_at, v.status, v.analysis,
           (SELECT count(*)::int FROM attachments a WHERE a.message_id = m.id) AS n_attach
    FROM verdicts v
    JOIN messages m ON m.id = v.message_id
    WHERE v.analysis ILIKE '%tidak mengandung unsur pelanggaran kebijakan server%'
       OR v.analysis ILIKE '%gaul/slang%'
    ORDER BY v.created_at DESC
    LIMIT 6`);
  console.log(`\n=== messages matching the quoted boilerplate: ${quoted.rows.length} ===`);
  for (const r of quoted.rows) {
    const age = Math.round((Date.now() - Number(r.created_at)) / 60000);
    console.log(
      `\n  ${r.id}  attach=${r.n_attach}  status=${r.status}  ${age}m ago`,
    );
    console.log(`    content : ${JSON.stringify((r.content ?? "").slice(0, 60))}`);
    console.log(`    analysis: ${(r.analysis ?? "").slice(0, 170)}`);
  }
} catch (e) {
  console.log("ERR", e.message);
} finally {
  await pool.end();
}
