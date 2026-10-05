import { createServer, type Server } from "node:http";
import { createChildLogger } from "@/shared/logger/index";
import { createORPCWebSocketServer } from "../orpc/ws.js";
import { config } from "../shared/config/index.js";
import { initializeDatabase } from "../shared/database/drizzle.js";
import { startRedisBridge } from "../ws/redis-bridge.js";
import { createWebSocketServer } from "../ws/server.js";
import { createHttpApp } from "./app.js";

const logger = createChildLogger("http.server");

export async function startHttpServer(): Promise<Server> {
  // ONE pool now. This used to open the Prisma client for the dashboard's
  // reads while `gateway/bootstrap.ts` opened the Drizzle pool for writes — two
  // pools against one database, both at POSTGRES_POOL_MAX, so the process held
  // twice the connections it needed. The gateway already initialises Drizzle
  // and every repository now reads through the same handle, so this is the
  // only initialisation left.
  await initializeDatabase();

  const app = createHttpApp();
  const port = config.WEBSERVER_PORT;

  const server = createServer(app);

  // Attach WebSocket servers to the same HTTP server
  createWebSocketServer(server); // /ws — voice PCM + gateway events
  createORPCWebSocketServer(server); // /trpc — structured data RPCs

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

  return new Promise<Server>((resolve, reject) => {
    server.listen(port, () => {
      logger.info({ port }, "HTTP server started");
      resolve(server);
    });

    server.on("error", (err) => {
      logger.error({ err }, "HTTP server error");
      reject(err);
    });
  });
}
