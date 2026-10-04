import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.js";

export interface DbOptions {
  connectionString?: string;
  max?: number;
  min?: number;
}

/**
 * The v2 state machine's ai_status values. Prisma maps the column to String
 * (the database uses a CHECK constraint, not a native enum), so this union is
 * where the type safety has to live instead.
 */
export type AiStatus =
  | "pending"
  | "claimed"
  | "analyzed"
  | "retry_wait"
  | "dead"
  | "skipped";

export type Db = PrismaClient;

export function createDb(opts: DbOptions = {}): PrismaClient {
  const url =
    opts.connectionString ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:5433/gmw_mod";
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({
    adapter,
    log: process.env.VERBOSE === "true" ? ["query", "warn", "error"] : ["error"],
  });
}

let singleton: PrismaClient | undefined;

export function db(): PrismaClient {
  singleton ??= createDb();
  return singleton;
}

export async function disconnectDb(): Promise<void> {
  await singleton?.$disconnect();
  singleton = undefined;
}