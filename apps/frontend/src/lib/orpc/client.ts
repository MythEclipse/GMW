import { type ClientLink, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

/**
 * Browser-side oRPC client: RPC over HTTP POST to `/trpc`.
 *
 * This used to be a WebSocket — `RPCLink` from `@orpc/client/websocket` over a
 * partysocket `ReconnectingWebSocket`, behind a ~100-line adapter class that
 * existed only to narrow that library's `readyState: number` to the DOM's
 * `0 | 1 | 2 | 3`. All of that is gone: `HttpLink` speaks fetch, so there is no
 * socket, no reconnect policy, and no adapter.
 *
 * The backend already served both transports over the same `/trpc` path; this
 * just stops opening the socket.
 *
 * `/ws` is UNRELATED and still required. That socket carries Discord live
 * events (message_created, moderation_action, presence_updated — 22 types) via
 * `@/lib/ws`. It is push-only: every subscriber there treats a payload as a
 * notification and re-issues a query rather than rendering it. So the two are
 * genuinely separate concerns and only this one moved.
 */
function rpcUrl(): string {
  const configured = import.meta.env.VITE_API_URL;
  if (configured) return `${configured.replace(/\/$/, "")}/trpc`;

  // Same-origin: the reverse proxy forwards /trpc to the backend, so no host is
  // ever hardcoded here.
  return "/trpc";
}

let link: ClientLink<Record<string, never>> | null = null;

function getLink(): ClientLink<Record<string, never>> {
  if (link) return link;
  link = new RPCLink({
    url: rpcUrl(),
    // Cookies, not headers: the dashboard is a private reverse-proxy app with
    // no auth of its own, so nothing here may require a bearer token.
    //
    // Same class name as the WebSocket adapter's `RPCLink`, imported from
    // `@orpc/client/fetch` instead of `@orpc/client/websocket`. Same RPC
    // protocol, different transport.
    fetch: (request, init) =>
      fetch(request, { ...init, credentials: "include" }),
  }) as ClientLink<Record<string, never>>;
  return link;
}

let client: unknown = null;

/**
 * Lazily-built client, so a server render never constructs anything
 * browser-only. Only safe to call from a client component.
 */
export function getBrowserClient() {
  if (!client) {
    client = createORPCClient(getLink() as never);
  }
  return client as ReturnType<typeof createORPCClient>;
}
