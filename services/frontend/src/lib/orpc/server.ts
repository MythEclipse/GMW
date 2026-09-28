import "server-only";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RpcClient } from "@/lib/types/rpc";

/**
 * Server-side oRPC client, used by React Server Components to seed each page.
 *
 * Speaks plain HTTP (`POST /trpc/<router>/<procedure>`) to the backend. The
 * backend serves the same `appRouter` on two transports sharing that path — a
 * WebSocket for the browser and HTTP for the server render — so the procedure
 * set is identical on both sides.
 *
 * `GMW_BACKEND_URL` points straight at the backend (127.0.0.1:4001) because
 * this executes inside the Next server, not through the public proxy. Never
 * import this from a client component; use `@/lib/orpc/client` there.
 */
const BACKEND_URL = process.env.GMW_BACKEND_URL ?? "http://127.0.0.1:4001";

const rawClient = createORPCClient(
  new RPCLink({
    url: `${BACKEND_URL}/trpc`,
    // This dashboard is a live moderation monitor: a cached SSR payload would
    // show a queue state that has already moved on. Never cache.
    fetch: (url, options) => fetch(url, { ...options, cache: "no-store" }),
  }),
);

export const serverClient = rawClient as unknown as RpcClient;
