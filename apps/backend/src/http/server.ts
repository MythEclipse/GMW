import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createChildLogger } from "@/shared/logger/index";
import { createORPCWebSocketServer } from "../orpc/ws.js";
import { config } from "../shared/config/index.js";
import { initializeDatabase } from "../shared/database/drizzle.js";
import { startRedisBridge } from "../ws/redis-bridge.js";
import { createWebSocketServer } from "../ws/server.js";
import { createHttpApp } from "./app.js";

const logger = createChildLogger("http.server");

/**
 * `serve()` RETURNS THE UNDERLYING `http.Server`, and that is the whole point.
 *
 * Both WebSocket servers register their own `server.on("upgrade")` listener and
 * route by URL — `/ws` for voice+gateway events, `/trpc` for RPC. They are built
 * with `noServer: true` precisely because two `ws` servers bound via the
 * `server` option both register upgrade listeners and the path-guarded one
 * rejects the other's path.
 *
 * So this file must NOT reach for `hono/ws`'s `upgradeWebSocket`, and must NOT
 * wrap the app in anything that hides the Server. `serve()` hands the Server
 * back, and both listeners attach to it exactly as they did under Express.
 *
 * If a future `@hono/node-server` release starts installing its own `upgrade`
 * listener on that Server, the fallback is to stop using `serve()` and build it
 * by hand: `createServer(handle(app))` from `@hono/node-server` returns a plain
 * `(req, res) => void`, giving a bare http.Server with no Hono involvement in
 * the upgrade path.
 */
export async function startHttpServer(): Promise<Server> {
  // ONE pool now. This used to open the Prisma client for the dashboard's
  // reads while `gateway/bootstrap.ts` opened the Drizzle pool for writes — two
  // pools against one database, both at POSTGRES_POOL_MAX. The gateway already
  // initialises Drizzle and every repository now reads through the same handle,
  // so this is the only initialisation left.
  await initializeDatabase();

  const app = createHttpApp();
  const port = config.WEBSERVER_PORT;

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, "HTTP server started");
  });

  // Attach WebSocket servers to the same HTTP server.
  createWebSocketServer(server as Server); // /ws — voice PCM + gateway events
  createORPCWebSocketServer(server as Server); // /trpc — structured data RPCs

  // `serve()` binds eagerly, where the Express version returned a promise that
  // rejected on a listen error — so a port conflict used to abort startup with
  // a clean rejection. `server.on("error")` restores that: without a listener,
  // an EADDRINUSE here would be an unhandled 'error' event and take the process
  // down with a stack trace instead of the logged fatal the caller expects.
  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  // Redis pub/sub bridge: forwards capture events to dashboard WS clients.
  //
  // Started, NOT awaited. `startRedisBridge` pings, and ioredis only rejects
  // that ping after burning through 20 reconnect attempts — around a minute with
  // Redis down. Awaiting it meant the HTTP port stayed closed until then, so a
  // Redis outage took the DASHBOARD down with it: nothing to look at, and
  // nothing to restart the dashboard from. The dashboard reads Postgres, not
  // Redis, so it is fully useful without this bridge.
  //
  // Left unattached on purpose. ioredis retries on its own, so a bridge that
  // starts after Redis returns still comes up; what is lost while Redis is down
  // is live events, which the next page load reconciles from the database. The
  // one failure worth surfacing loudly is a misconfigured REDIS_URL, and an
  // unhandled rejection would take the process down for it — so the rejection
  // is caught and logged here instead.
  void startRedisBridge().catch((err) =>
    logger.error(
      { err },
      "Redis bridge did not start — live events are missed, but the dashboard is up",
    ),
  );

  return server as Server;
}
