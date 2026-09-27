import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import type { PoolClient } from "pg";
import { createChildLogger } from "@/shared/logger/index";
import {
  closeDatabase,
  initializeDatabase,
  withDatabaseClient,
} from "./drizzle.js";
import * as schema from "./schema.js";

const logger = createChildLogger("migrate");
const MIGRATION_LOCK_KEY_1 = 2026;
const MIGRATION_LOCK_KEY_2 = 531;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Read the Drizzle migration journal and return the tag (hash) of the
 * first migration entry. This avoids hardcoding "0000_tricky_mysterio"
 * which would break if the initial migration is ever regenerated.
 */
async function getFirstMigrationTag(): Promise<string> {
  const journalPath = join(
    process.cwd(),
    "drizzle/migrations/meta/_journal.json",
  );
  const raw = await readFile(journalPath, "utf-8");
  const journal: MigrationJournal = JSON.parse(raw);

  if (!journal.entries || journal.entries.length === 0) {
    throw new Error(
      "Migration journal is empty — cannot determine first migration tag",
    );
  }

  // Entries are ordered by idx — the first entry is the initial migration.
  const first = journal.entries.reduce((earliest, entry) =>
    entry.idx < earliest.idx ? entry : earliest,
  );
  return first.tag;
}

/**
 * Read the Drizzle migration journal and return the `when` (folderMillis)
 * timestamp of the LAST migration entry. Drizzle's PG migrator applies a
 * migration only when `tracked_max_created_at < migration.when`, so seeding
 * the tracking table with this value marks every existing journal migration
 * as already applied.
 */
async function getLastMigrationWhen(): Promise<number> {
  const journalPath = join(
    process.cwd(),
    "drizzle/migrations/meta/_journal.json",
  );
  const raw = await readFile(journalPath, "utf-8");
  const journal: MigrationJournal = JSON.parse(raw);

  if (!journal.entries || journal.entries.length === 0) {
    throw new Error(
      "Migration journal is empty — cannot determine last migration timestamp",
    );
  }

  const last = journal.entries.reduce((newest, entry) =>
    entry.when > newest.when ? entry : newest,
  );
  return last.when;
}

/**
 * Seed Drizzle's __drizzle_migrations tracking table for pre-existing databases
 * that were created manually or by an earlier migration system (e.g., the old
 * checkSchemaExists short-circuit). Without this, Drizzle attempts to re-create
 * all tables from 0000 and fails with "relation already exists".
 *
 * The Drizzle PG migrator (drizzle-orm 0.45.x) only reads the LAST tracked
 * migration (`SELECT ... ORDER BY created_at DESC LIMIT 1` from
 * <migrationsSchema>.__drizzle_migrations) and re-applies every journal
 * migration whose `when` is newer than that value. If the tracking table is
 * empty or missing the latest entries while the DB schema is already up to
 * date, re-running the migrations crashes with "column/relation already
 * exists" — putting the gateway into an infinite restart loop.
 *
 * So instead of early-returning when the table exists (which left it empty /
 * partial and caused this exact crash), we RECONCILE: when the DB is a
 * pre-existing one (app tables already present) and the schema already
 * reflects the latest migration, we seed the tracking table up to the latest
 * journal `when` so Drizzle skips everything instead of re-applying it.
 */
// Exported for tests: the reconciler is where a data-only migration can be
// silently stamped as applied, and that is only reproducible by driving this
// function directly against a poisoned tracking table.
export async function seedDrizzleHistory(client: PoolClient): Promise<void> {
  // Check whether the app tables pre-exist (old ./migrations/ SQL or manual
  // creation). If not, this is a brand-new database — let Drizzle handle it.
  const hasTextCache = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_name = 'text_analysis_cache' AND column_name = 'text'
    )
  `);
  if (hasTextCache.rows[0]?.exists !== true) {
    return; // brand-new database, let Drizzle handle everything
  }

  // Final schema "at latest migration" sentinel.
  //
  // This MUST name the newest migration's own objects, not some older one.
  // It previously tested `moderation_actions.server_nick` (added at 0019),
  // which every production database has. So when 0020 was added, the sentinel
  // still reported "at latest" and this function stamped 0020 into
  // __drizzle_migrations as applied WITHOUT RUNNING IT — production booted
  // against a schema with no verdicts table, no claim_messages(), and no
  // ai_status state machine. `ai_status` looked present only because v1 had
  // an unrelated column of that name.
  //
  // The test below checks 0020's actual objects: a column unique to it
  // (`messages.lease_until`) plus both new tables. If they exist, 0020 really
  // ran and the reconcile is safe; if any is missing, Drizzle must apply it.
  const atLatest = await client.query(`
    SELECT
      -- 0020's own objects: a column unique to it plus both new tables.
      EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'lease_until'
      )
      AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'verdicts'
      )
      AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'analysis_attempts'
      )
      -- 0021's own effect. It is DATA-ONLY: it creates no table, column or
      -- function, so testing 0020's objects alone made this sentinel report
      -- "at latest" on a database where the backfill had never run. The
      -- reconciler then stamped 0021 as applied without executing it, and
      -- 48,290 messages stayed permanently "unjudged" — the exact failure this
      -- sentinel exists to prevent, one migration later.
      --
      -- The test is "no judged message is missing its verdict", which is
      -- precisely what 0021 delivers. It is vacuously true on a database with
      -- no judged messages, which is the correct answer there.
      AND NOT EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.ai_analysis IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.message_id = m.id)
      )
      AS ok
  `);
  const schemaAtLatest = atLatest.rows[0]?.ok === true;

  const lastMigrationWhen = await getLastMigrationWhen();

  // Create the Drizzle tracking table if it does not exist.
  // PG15+ locks down CREATE on the public schema for non-owner roles,
  // so we handle the permission error gracefully by checking if the
  // table already exists (it was created by a previous migration run).
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
  } catch (createErr: unknown) {
    if (
      createErr instanceof Error &&
      "code" in createErr &&
      (createErr as { code: string }).code === "42501"
    ) {
      // Permission denied — check if the table actually exists anyway
      const existsAfter = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = '__drizzle_migrations'
        )
      `);
      if (existsAfter.rows[0]?.exists === true) {
        logger.warn(
          "CREATE TABLE __drizzle_migrations denied (42501) but table already exists — continuing",
        );
      } else {
        throw createErr;
      }
    } else {
      throw createErr;
    }
  }

  // Current max tracked created_at. Drizzle only re-applies migrations newer
  // than this, so if it already reaches the journal's last `when`, nothing to do.
  const tracked = await client.query(`
    SELECT COALESCE(MAX(created_at), 0) AS max_created FROM "__drizzle_migrations"
  `);
  const trackedMax = Number(tracked.rows[0]?.max_created ?? 0);

  if (trackedMax >= lastMigrationWhen && !schemaAtLatest) {
    // The tracking table claims the newest migration ran, but its objects are
    // absent. This is the self-inflicted wound from the old sentinel: a
    // previous boot seeded `<tag>@<when>-reconciled` while testing a column
    // unrelated to 0020, permanently marking it applied.
    //
    // Drizzle only applies migrations NEWER than the tracked max, so it will
    // never retry 0020 on its own — the row has to be rolled back first.
    // Without this, production boots healthy forever against a schema that has
    // no verdicts table and no claim_messages(), and the worker silently
    // analyses nothing.
    // Roll back the marker so Drizzle re-runs the newest migration for real.
    //
    // Two shapes have to go:
    //   - `<tag>@<when>-reconciled`: seeded by the reconciler itself.
    //   - a plain `<when>` row: Drizzle's own hash. If a previous run applied
    //     the tracking row but the statement failed, or the sentinel stamped
    //     the newest `when` while the backfill behind it never ran, the row
    //     looks legitimately applied and Drizzle skips it forever. Since
    //     `schemaAtLatest` is false, the objects really are missing, so
    //     removing the row is the only way to get the work done.
    const stale = await client.query(
      `DELETE FROM "__drizzle_migrations" WHERE created_at = $1`,
      [lastMigrationWhen],
    );
    if (stale.rowCount && stale.rowCount > 0) {
      logger.warn(
        { lastMigrationWhen, removed: stale.rowCount },
        "Rolled back a migration marker whose objects are missing — " +
          "Drizzle will now apply it for real",
      );
    }
    // Deliberately NO return here. The whole point of rolling the marker back
    // is to let Drizzle run the migration, and runMigrations() calls Drizzle
    // unconditionally after this function. Returning early (as this did when
    // the block was written) rolled the marker back and then still skipped the
    // work, leaving the database exactly as broken as before — the log line
    // claimed Drizzle "will now apply it" while guaranteeing it would not.
  }

  if (trackedMax >= lastMigrationWhen) {
    return; // already fully tracked — Drizzle will apply only genuinely-pending ones
  }

  if (!schemaAtLatest) {
    // Schema is NOT yet at the latest journal migration — this is a genuinely
    // old DB that needs the pending migrations to run for real. Let Drizzle
    // apply them. (Idempotent migration SQL guards legacy partial states.)
    logger.info(
      { trackedMax, lastMigrationWhen },
      "DB schema behind latest journal migration — leaving pending migrations to run",
    );
    return;
  }

  // Schema already reflects the latest migration but the tracking table is
  // behind (e.g. migrations applied manually/out-of-band without being
  // recorded). Seed up to the last journal `when` so Drizzle skips them
  // instead of re-running already-applied DDL and crashing. This is the
  // recovery that broke the gateway's infinite-restart loop.
  const journalTag = `${await getFirstMigrationTag()}@${lastMigrationWhen}-reconciled`;
  await client.query(
    `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
    [journalTag, lastMigrationWhen],
  );
  logger.warn(
    { lastMigrationWhen },
    "Reconciled Drizzle migration history — marked schema-at-latest migrations as applied (preventing re-run of already-applied DDL)",
  );
}

export async function runMigrations(): Promise<void> {
  try {
    logger.info("Starting PostgreSQL migrations");
    await initializeDatabase();

    try {
      await withDatabaseClient(async (client) => {
        const db = drizzlePostgres(client, { schema });

        await client.query("SELECT pg_advisory_lock($1, $2)", [
          MIGRATION_LOCK_KEY_1,
          MIGRATION_LOCK_KEY_2,
        ]);

        try {
          // Seed history for pre-existing databases so Drizzle only applies
          // new (pending) migrations — it is idempotent after that.
          await seedDrizzleHistory(client);

          // Monkey-patch client.query to intercept and ignore Drizzle's
          // hardcoded schema creation, which fails in PG15+ restricted public schemas.
          const originalQuery = client.query;
          client.query = (async (...args: any[]) => {
            const queryText = args[0];
            const text =
              typeof queryText === "string" ? queryText : queryText?.text;
            if (
              text &&
              typeof text === "string" &&
              text.includes('CREATE SCHEMA IF NOT EXISTS "public"')
            ) {
              return {
                rows: [],
                command: "CREATE",
                rowCount: 0,
                oid: 0,
                fields: [],
              };
            }
            return Function.prototype.apply.call(originalQuery, client, args);
          }) as typeof client.query;

          try {
            await migratePostgres(db, {
              migrationsFolder: "./drizzle/migrations",
              migrationsSchema: "public",
            });
          } finally {
            client.query = originalQuery;
          }
        } finally {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [
            MIGRATION_LOCK_KEY_1,
            MIGRATION_LOCK_KEY_2,
          ]);
        }
      });
    } finally {
      await closeDatabase();
    }

    logger.info("PostgreSQL migrations completed successfully");
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Migration failed",
    );
    throw error;
  }
}
