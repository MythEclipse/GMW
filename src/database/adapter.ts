import { createChildLogger } from "../logger";
import { config } from "../config";
import * as postgres from "./postgres";
import * as sqliteModule from "../muxer-queue";

const logger = createChildLogger("db-adapter");

/**
 * Unified database adapter interface matching SQLite API
 */
export interface DatabaseStatement {
  run: (...params: unknown[]) => { changes: number };
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
}

export interface DatabaseAdapter {
  prepare: (sql: string) => DatabaseStatement;
  exec: (sql: string) => void;
  close: () => Promise<void>;
}

/**
 * PostgreSQL adapter implementing DatabaseAdapter interface
 */
class PostgresAdapter implements DatabaseAdapter {
  prepare(sql: string): DatabaseStatement {
    // Convert SQLite placeholders (?) to PostgreSQL placeholders ($1, $2, etc.)
    const pgSql = this.convertPlaceholders(sql);

    return {
      run: (...params: unknown[]) => {
        return this.runSync(pgSql, params);
      },
      all: (...params: unknown[]) => {
        return this.allSync(pgSql, params);
      },
      get: (...params: unknown[]) => {
        return this.getSync(pgSql, params);
      },
    };
  }

  exec(sql: string): void {
    // For PostgreSQL, exec is typically used for schema creation
    // We'll queue this for execution but note that exec() is synchronous in SQLite
    // and async in PostgreSQL, so this is a limitation of the adapter
    logger.warn(
      "exec() called on PostgreSQL adapter - this is not truly synchronous. Use query() for schema operations.",
    );
    // In practice, schema operations should be handled separately via migrations
  }

  async close(): Promise<void> {
    await postgres.closePool();
  }

  /**
   * Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
   */
  private convertPlaceholders(sql: string): string {
    let paramIndex = 1;
    return sql.replace(/\?/g, () => `$${paramIndex++}`);
  }

  /**
   * Synchronous wrapper for run() - note: this is a limitation
   * In production, async operations should be handled properly
   */
  private runSync(sql: string, params: unknown[]): { changes: number } {
    // This is a placeholder - actual implementation would need async handling
    // For now, we'll throw an error to indicate this needs proper async handling
    logger.error(
      "runSync called on PostgreSQL adapter - this operation must be async",
    );
    throw new Error(
      "PostgreSQL adapter requires async operations. Use query() directly instead of prepare().run()",
    );
  }

  /**
   * Synchronous wrapper for all() - note: this is a limitation
   */
  private allSync(sql: string, params: unknown[]): unknown[] {
    logger.error(
      "allSync called on PostgreSQL adapter - this operation must be async",
    );
    throw new Error(
      "PostgreSQL adapter requires async operations. Use query() directly instead of prepare().all()",
    );
  }

  /**
   * Synchronous wrapper for get() - note: this is a limitation
   */
  private getSync(sql: string, params: unknown[]): unknown {
    logger.error(
      "getSync called on PostgreSQL adapter - this operation must be async",
    );
    throw new Error(
      "PostgreSQL adapter requires async operations. Use query() directly instead of prepare().get()",
    );
  }
}

/**
 * SQLite adapter wrapping better-sqlite3
 */
class SqliteAdapter implements DatabaseAdapter {
  private db: sqliteModule.SqliteDatabase;

  constructor(db: sqliteModule.SqliteDatabase) {
    this.db = db;
  }

  prepare(sql: string): DatabaseStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...params),
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    await sqliteModule.closeQueue();
  }
}

/**
 * Get database adapter based on configuration
 * Returns appropriate adapter (PostgreSQL or SQLite)
 */
export async function getDatabase(): Promise<DatabaseAdapter> {
  if (config.DATABASE_TYPE === "postgres") {
    logger.info("Initializing PostgreSQL adapter");
    const pool = postgres.getPool();
    logger.info(
      {
        host: postgres.buildConfig().host,
        port: postgres.buildConfig().port,
        database: postgres.buildConfig().database,
      },
      "PostgreSQL connection pool initialized",
    );
    return new PostgresAdapter();
  } else {
    logger.info("Initializing SQLite adapter");
    const db = sqliteModule.getDatabase();
    logger.info("SQLite database initialized");
    return new SqliteAdapter(db);
  }
}

/**
 * Get database adapter synchronously (for SQLite)
 * Note: This only works for SQLite. PostgreSQL requires async initialization.
 */
export function getDatabaseSync(): DatabaseAdapter {
  if (config.DATABASE_TYPE === "postgres") {
    logger.warn(
      "getDatabaseSync called with PostgreSQL - use getDatabase() instead for proper async handling",
    );
    return new PostgresAdapter();
  } else {
    const db = sqliteModule.getDatabase();
    return new SqliteAdapter(db);
  }
}
