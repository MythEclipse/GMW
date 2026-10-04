import { PrismaClient } from "@gmw/db/prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool, PoolClient } from "pg";
import { createChildLogger } from "../logger/index.js";
import { closePool, createPoolFromConfig } from "./pool.js";

const logger = createChildLogger("database.init");

let db: PrismaClient | null = null;
let rawPool: Pool | null = null;

export interface DatabaseConfig {
  DATABASE_URL?: string;
  POSTGRES_HOST?: string;
  POSTGRES_PORT?: number;
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  POSTGRES_DB?: string;
  POSTGRES_POOL_MIN?: number;
  POSTGRES_POOL_MAX?: number;
}

function connectionString(cfg: DatabaseConfig): string {
  if (cfg.DATABASE_URL) return cfg.DATABASE_URL;
  const user = encodeURIComponent(cfg.POSTGRES_USER ?? "postgres");
  const pass = encodeURIComponent(cfg.POSTGRES_PASSWORD ?? "postgres");
  const host = cfg.POSTGRES_HOST ?? "localhost";
  const port = cfg.POSTGRES_PORT ?? 5432;
  const database = cfg.POSTGRES_DB ?? "postgres";
  return `postgresql://${user}:${pass}@${host}:${port}/${database}`;
}

export async function initializeDatabase(cfg: DatabaseConfig) {
  if (db !== null) return db;

  const url = connectionString(cfg);
  rawPool = createPoolFromConfig({
    url,
    min: cfg.POSTGRES_POOL_MIN,
    max: cfg.POSTGRES_POOL_MAX,
  });

  db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: ["error"],
  });

  try {
    await db.$queryRaw`SELECT 1`;
    logger.info("Database connection successful");
  } catch (err) {
    logger.error({ err }, "Failed to connect to database");
    throw err;
  }

  return db;
}

export function getDatabase(): PrismaClient {
  if (db === null) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return db;
}

export function getPool(): Pool {
  if (!rawPool) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return rawPool;
}

export async function closeDatabase() {
  await db?.$disconnect();
  db = null;
  if (rawPool !== null) {
    await closePool(rawPool);
  }
  rawPool = null;
  logger.info("Database connection closed");
}

/**
 * Raw-query escape hatch, still used by repositories mid-migration. `?` is
 * rewritten to Postgres `$n` placeholders so call sites need no change.
 */
function convertPlaceholdersForPostgres(sql: string) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function executeAll(sql: string, params?: unknown[]) {
  const query = convertPlaceholdersForPostgres(sql);
  return (await getPool().query(query, params ?? [])).rows;
}

export async function executeGet(sql: string, params?: unknown[]) {
  const rows = await executeAll(sql, params);
  return rows[0] ?? null;
}

export async function withDatabaseClient<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}
