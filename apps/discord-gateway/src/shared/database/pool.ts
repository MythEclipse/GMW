import { type PoolConfig as PgPoolConfig, Pool } from "pg";
import { createChildLogger } from "../logger/index.js";

const log = createChildLogger("database.pool");

export interface PoolConfig {
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  min?: number;
  max?: number;
}

/**
 * Attach the handlers node-postgres requires to keep an idle client from
 * taking the process down.
 *
 * ## Why this is not optional
 *
 * `pg.Pool` emits `error` on the pool AND on each idle client that the server
 * drops (a routine `idle_in_transaction_session_timeout` / server restart /
 * network blip). With no listener, that EventEmitter 'error' is an unhandled
 * error: Node prints it and exits the process with code 1.
 *
 * So a routine backend restart killed the whole gateway, and every message
 * that had been committed as `processing` was stranded — the exact "stuck
 * message" report this rewrite exists to eliminate. Verified: there was no
 * `pool.on("error")` anywhere in the service.
 *
 * `pg.PoolConfig` also accepts `idleTimeoutMillis`; without it the pool keeps
 * dead clients until the next checkout, which is what produces the error in
 * the first place.
 */
export function attachPoolHandlers(pool: Pool, label = "pg"): Pool {
  pool.on("error", (err) => {
    // Log and continue. The pool discards the broken client on its own; the
    // next checkout opens a fresh connection. Exiting here is what turned a
    // routine disconnect into total message loss.
    log.error(
      { err, pool: label },
      "idle postgres client errored; discarding it",
    );
  });

  pool.on("connect", () => {
    log.debug({ pool: label }, "postgres client connected");
  });

  return pool;
}

export function createPoolFromConfig(cfg: PoolConfig): Pool {
  const opts: PgPoolConfig = {
    min: cfg.min ?? 2,
    max: cfg.max ?? 10,
    // Reap idle clients well before the server's idle timeout would, so a
    // dropped connection is never discovered by an application query.
    idleTimeoutMillis: 30_000,
    // Bound how long a caller waits for a connection instead of queueing
    // forever behind a saturated pool.
    connectionTimeoutMillis: 10_000,
  };

  if (cfg.url) {
    opts.connectionString = cfg.url;
  } else {
    opts.host = cfg.host;
    opts.port = cfg.port;
    opts.user = cfg.user;
    opts.password = cfg.password;
    opts.database = cfg.database;
  }

  return attachPoolHandlers(new Pool(opts), cfg.database ?? cfg.host ?? "pg");
}

export function closePool(pool: Pool | null): Promise<void> {
  if (!pool) return Promise.resolve();
  return pool.end();
}
