import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { onError } from "@orpc/server"
import { RPCHandler } from "@orpc/server/ws"
import { WebSocketServer } from "ws"
import { createChildLogger } from "../../infrastructure/logger/index.js"
import { appRouter } from "./router"

const logger = createChildLogger("orpc.ws")

/**
 * Attach the oRPC WebSocket handler to the shared HTTP server, on a path
 * SEPARATE from the voice/binary WebSocket (`/ws`). All structured data RPCs
 * (dashboard, messages, moderation, media, voice control, recordings,
 * analysis, chatbot, config, ui-state) flow over this `/trpc` socket; the
 * `/ws` socket is left untouched for Discord PCM audio + gateway events.
 *
 * We use `noServer` + a manual `upgrade` router (instead of
 * `new WebSocketServer({ server, path: "/trpc" })`) because two `ws` servers
 * mounted with the `server` option on the SAME http.Server both register
 * `upgrade` listeners, and `ws`'s path-guarded listener can reject (400) the
 * other server's path. Routing the upgrade ourselves by URL keeps `/trpc`
 * and `/ws` fully isolated.
 */
export function createORPCWebSocketServer(server: Server): WebSocketServer {
	const handler = new RPCHandler(appRouter, {
		interceptors: [
			onError((error) => logger.error({ error }, "oRPC WS error")),
		],
	})

	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

	server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (!req.url?.startsWith("/trpc")) return // let the /ws server handle it
		wss.handleUpgrade(req, socket, head, (ws) => {
			// Was `context: {}`. The write guard reads `x-mutation-token` off the
			// context headers, so this transport needs them for parity with the
			// HTTP one in http/app.ts — otherwise a mutation sent over the socket
			// is rejected even with a valid token and the two transports disagree.
			//
			// Node's IncomingMessage.headers is a flat record; the WHATWG Headers
			// the guard expects is built here, joining repeated names the way
			// fetch does.
			const headers = new Headers()
			for (const [key, value] of Object.entries(req.headers)) {
				if (value === undefined) continue
				headers.set(
					key,
					Array.isArray(value) ? value.join(", ") : String(value),
				)
			}
			handler.upgrade(ws, { context: { headers } })
		})
	})

	logger.info({ path: "/trpc" }, "oRPC WebSocket server attached")
	return wss
}
