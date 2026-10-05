import {
  closeDatabase as sharedCloseDb,
  executeAll as sharedExecAll,
  executeGet as sharedExecGet,
  getDatabase as sharedGetDb,
  getPool as sharedGetPool,
  initializeDatabase as sharedInit,
  withDatabaseClient as sharedWithClient,
} from "@/shared/database/init-drizzle";
import { createChildLogger } from "@/shared/logger/index";
import { config } from "../../shared/config/index.js";
import * as schema from "./schema.js";

const logger = createChildLogger("drizzle");

/**
 * Write-side database handle (Drizzle over a raw pg Pool).
 *
 * The dashboard reads through Prisma (`./index.ts`); capture and the moderation
 * worker write through this. One process holds both handles, so both must be
 * closed on shutdown — hence the distinct names.
 */

const dbConfig = {
  DATABASE_URL: config.DATABASE_URL,
  POSTGRES_HOST: config.POSTGRES_HOST,
  POSTGRES_PORT: config.POSTGRES_PORT,
  POSTGRES_USER: config.POSTGRES_USER,
  POSTGRES_PASSWORD: config.POSTGRES_PASSWORD,
  POSTGRES_DB: config.POSTGRES_DB,
  POSTGRES_POOL_MIN: config.POSTGRES_POOL_MIN,
  POSTGRES_POOL_MAX: config.POSTGRES_POOL_MAX,
};

export async function initializeDatabase() {
  logger.info("Initializing database");
  return sharedInit(dbConfig, schema);
}

export function getDatabase() {
  return sharedGetDb();
}

// Named distinctly from the Prisma pool in ./index.ts: both are live in one
// process now, and a shared name would make the shutdown call ambiguous.
export const closeDrizzleDatabase = sharedCloseDb;
export const getDrizzlePool = sharedGetPool;
export const executeAll = sharedExecAll;
export const executeGet = sharedExecGet;
export const withDatabaseClient = sharedWithClient;
