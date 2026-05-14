import "dotenv/config";
import Database from "better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config";
import { createChildLogger } from "../logger";
import { initializeDatabase } from "./drizzle";

const logger = createChildLogger("migrate");

export async function runMigrations(): Promise<void> {
  try {
    logger.info("Starting database migrations");

    if (config.DATABASE_TYPE === "postgres") {
      logger.info("Running PostgreSQL migrations");
      const db = await initializeDatabase();
      await migrate(db as any, { migrationsFolder: "./drizzle/migrations" });
      logger.info("PostgreSQL migrations completed successfully");
    } else {
      logger.info("Running SQLite migrations");
      const sqlite = new Database(".muxer-queue.db");
      sqlite.pragma("journal_mode = WAL");
      const db = require("drizzle-orm/better-sqlite3").drizzle(sqlite);
      migrateSqlite(db, { migrationsFolder: "./drizzle/migrations" });
      logger.info("SQLite migrations completed successfully");
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Migration failed",
    );
    throw error;
  }
}

// Run migrations if called directly
if (require.main === module) {
  runMigrations()
    .then(() => {
      logger.info("Migrations completed");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, "Migration failed");
      process.exit(1);
    });
}
