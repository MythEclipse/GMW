/**
 * Why does releaseStaleClaims fail every tick in production?
 *
 * The enforcer logs "Auto-delete tick failed" with a Drizzle "Failed query"
 * message but no cause, so the actual error is invisible. This runs the exact
 * statement against production's schema (read-only: it only re-queues claims
 * older than 60s, and claims only exist if this run created them) and prints
 * the underlying error.
 *
 * Run: DSN=<prod dsn> bun tests/enforcer-query-repro.mjs
 */
import { sql } from "drizzle-orm";
import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
  console.error("DSN is required");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: dsn, max: 1 });

// Same statement, raw pg first — to separate "SQL is wrong" from
// "the Drizzle wrapper is wrong".
const cutoff = Date.now() - 60_000;
try {
  const r = await pool.query(
    `UPDATE verdicts
     SET auto_delete_state = 'pending'
     WHERE auto_delete_state = 'claimed'
       AND auto_delete_claimed_at < $1`,
    [cutoff],
  );
  console.log("raw pg release: OK, rows =", r.rowCount);
} catch (e) {
  console.log("raw pg release FAILED");
  console.log("   message:", e.message);
  console.log("   code   :", e.code);
  console.log("   detail :", e.detail ?? "(none)");
  console.log("   hint   :", e.hint ?? "(none)");
  console.log("   where  :", e.where ?? "(none)");
  console.log("   routine:", e.routine ?? "(none)");
}

// Now the same statement through the project's Drizzle setup, which is what
// the enforcer actually uses.
process.env.DISCORD_TOKEN ??= "repro";
process.env.AI_ANALYSIS_ENABLED ??= "false";
const { config } = await import("../src/shared/config/index.ts");
const schema = await import("../src/shared/database/schema.ts");
const { initializeDatabase, getDatabase, closeDatabase } = await import(
  "../src/shared/database/init.ts"
);

try {
  await initializeDatabase(config, schema);
  const db = getDatabase();
  const res = await db.execute(sql`
    UPDATE verdicts
    SET ${sql.raw("auto_delete_state")} = 'pending'
    WHERE ${sql.raw("auto_delete_state")} = 'claimed'
      AND ${sql.raw("auto_delete_claimed_at")} < ${cutoff}
  `);
  console.log("\ndrizzle release: OK");
  console.log("   returned:", JSON.stringify(res)?.slice(0, 160));
} catch (e) {
  console.log("\ndrizzle release FAILED");
  console.log("   message:", String(e.message).slice(-200));
  console.log("   cause  :", (e.cause?.message ?? "(none)").slice(0, 300));
  console.log("   code   :", e.cause?.code ?? e.code ?? "(none)");
} finally {
  try {
    await closeDatabase();
  } catch {
    // closeDatabase may already be closed
  }
  await pool.end();
}
