import type { drizzle } from "drizzle-orm/node-postgres"

/**
 * The database handle every repository takes, defined once.
 *
 * BEFORE THIS EXISTED, every repository method called the process-global
 * `getDatabase()` from `./drizzle`, which throws "Database not initialized"
 * unless `initializeDatabase()` has already run. A repository could therefore
 * not be unit-tested without a live Postgres. That constraint is why ten
 * integration test files share one database and truncate each other's tables,
 * which in turn is why `vitest.config.ts` sets `fileParallelism: false`.
 *
 * WHY THE CONCRETE DRIZZLE TYPE AND NOT A HAND-WRITTEN INTERFACE: a structural
 * interface with `select(...): unknown` erases the entire query-builder chain
 * and buries the repositories in type errors — the chain is the whole point.
 * Injecting the HANDLE is the seam that matters; the shape stays exact.
 *
 * WHY NOT `ReturnType<typeof getDatabase>`: that would make every repository
 * import the global it was just decoupled from. Deriving from `drizzle` keeps
 * this file free of that dependency.
 *
 * Repositories that only need `execute` (see modules/health) still declare a
 * narrower local interface, because a test can satisfy that with a two-line
 * stub and no Drizzle involved at all.
 */
export type DatabaseHandle = ReturnType<typeof drizzle>
