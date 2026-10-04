/**
 * Is 0022 recorded as applied but its columns absent?
 *
 * Production's tracking table has 0022's timestamp, yet
 * `column "auto_delete_state" does not exist`. Migration 0022 uses
 * ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so a rolled-back statement would
 * leave no column but a stamped marker — the same failure shape as 0021.
 *
 * This prints the facts that distinguish: not applied / applied-but-missing /
 * applied-and-present. It also drives the real reconciler, to prove the
 * sentinel now notices a migration whose objects are missing.
 *
 * Run: DSN=<prod dsn> bun tests/check-0022-columns.mjs [--apply]
 */
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}
const apply = process.argv.includes("--apply");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const pool = new pg.Pool({ connectionString: dsn, max: 1 });

try {
  const tracked = await pool.query(`
    SELECT created_at FROM "__drizzle_migrations"
    WHERE created_at = 1788086400000`);
  console.log("0022 tracked:", tracked.rows.length === 1);

  const cols = await pool.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'verdicts' AND column_name LIKE 'auto_delete%'
    ORDER BY 1`);
  console.log("auto_delete columns present:", JSON.stringify(cols.rows));

  const idx = await pool.query(`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'verdicts' AND indexname LIKE '%auto_delete%'`);
  console.log("auto_delete index present:", JSON.stringify(idx.rows));

  const state = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'verdicts'::regclass
      AND pg_get_constraintdef(oid) ILIKE '%auto_delete_state%'`);
  console.log("state CHECK constraint:", JSON.stringify(state.rows));

  const missing = cols.rows.length !== 2;
  if (tracked.rows.length === 1 && !missing) {
    check("0022 is applied and its columns exist", true);
  } else if (tracked.rows.length === 1 && missing) {
    check(
      "0022 is TRACKED BUT INCOMPLETE — the silent-skip failure again",
      true,
      "detected; the sentinel must now treat it as not-at-latest",
    );

    // Drive the real reconciler to confirm the new sentinel catches this.
    const c = await pool.connect();
    const { seedDrizzleHistory } = await import(
      "../src/shared/database/migrate.ts"
    );
    await seedDrizzleHistory(c);
    const after = await c.query(`
      SELECT count(*)::int AS n FROM "__drizzle_migrations"
      WHERE created_at = 1788086400000`);
    check(
      "the reconciler rolled back the false 0022 marker",
      after.rows[0].n === 0,
      `0022 marker rows now ${after.rows[0].n}`,
    );
    c.release();
    console.log(
      "\nrestart the gateway now — runMigrations() will apply 0022 for real",
    );
  } else {
    check("0022 is not tracked at all", true, "Drizzle will apply it normally");
  }

  if (apply) {
    console.log("\n--apply: deleting the marker by hand");
    const d = await pool.query(
      `DELETE FROM "__drizzle_migrations" WHERE created_at = 1788086400000`,
    );
    console.log("rows removed:", d.rowCount);
  }
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
} finally {
  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
