import { type ClientLink, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import ReconnectingWebSocket from "partysocket/ws";

/**
 * Browser-side oRPC client: RPC over the `/trpc` WebSocket.
 *
 * The backend mounts two upgrade handlers on one HTTP server and routes by
 * URL — `/trpc` for structured RPC, `/ws` for the Discord event stream and PCM
 * audio. This client owns `/trpc`; `@/lib/ws` owns `/ws`. They are separate so
 * a reconnect storm on one never disturbs the other.
 *
 * `ReconnectingWebSocket` (partysocket's plain-URL base class, not the
 * partykit `PartySocket`, which requires a partykit host/room) handles
 * reconnection with backoff, so callers never need a special "offline" path.
 */
function websocketUrl(): string {
  // `import.meta.env`, not `process.env`: Vite defines neither `process` nor
  // `process.env`, so the old `process.env.NEXT_PUBLIC_WS_URL` raised a
  // ReferenceError while evaluating the argument — before the same-origin
  // fallback below could run. That killed the app on boot, as a blank page
  // with a single console error.
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) return configured;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Same-origin: the reverse proxy forwards /trpc to the backend, so no host
  // is ever hardcoded here.
  return `${protocol}//${window.location.host}/trpc`;
}

let link: ClientLink<Record<string, never>> | null = null;

/**
 * oRPC's `RPCLink` wants the native DOM shape
 * `Pick<WebSocket, "addEventListener" | "removeEventListener" | "send" | "readyState">`.
 *
 * `ReconnectingWebSocket` implements all four at runtime, but types
 * `readyState` as `number` (its CONNECTING/OPEN/CLOSING/CLOSED constants are
 * plain numbers) rather than the DOM's `0 | 1 | 2 | 3` union. Rather than
 * casting the mismatch away — which would hide a real break if the library ever
 * changed — this adapter narrows it explicitly and is the single place that
 * knows about the difference.
 */
class OrpcSocketAdapter
  implements
    Pick<
      WebSocket,
      "addEventListener" | "removeEventListener" | "send" | "readyState"
    >
{
  private readonly socket: ReconnectingWebSocket;

  constructor(url: string) {
    this.socket = new ReconnectingWebSocket(url, null, {
      maxRetries: Number.POSITIVE_INFINITY,
      // Grow the delay between attempts so a backend restart does not become a
      // reconnect storm, while still recovering quickly from a brief blip.
      minReconnectionDelay: 500,
      maxReconnectionDelay: 10_000,
      reconnectionDelayGrowFactor: 1.5,
    });
  }

  get readyState(): 0 | 1 | 2 | 3 {
    return this.socket.readyState as 0 | 1 | 2 | 3;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.socket.send(data as string);
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.socket.addEventListener(
      type as "message",
      callback as EventListener,
      options,
    );
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    this.socket.removeEventListener(
      type as "message",
      callback as EventListener,
      options,
    );
  }
}

function getLink(): ClientLink<Record<string, never>> {
  if (link) return link;

  const socket = new OrpcSocketAdapter(websocketUrl());

  link = new RPCLink({ websocket: socket }) as ClientLink<
    Record<string, never>
  >;
  return link;
}

let client: unknown = null;

/**
 * Lazily-built client, so a server render never constructs a WebSocket.
 * Only safe to call from a client component.
 */
export function getBrowserClient() {
  if (!client) {
    client = createORPCClient(getLink() as never);
  }
  return client as ReturnType<typeof createORPCClient>;
}
