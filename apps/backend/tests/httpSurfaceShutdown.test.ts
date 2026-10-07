import { once } from "node:events"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import type { UseCases } from "../src/presentation/composition.js"
import { stopHttpSurface } from "../src/presentation/http/server.js"
import { createORPCWebSocketServer } from "../src/presentation/orpc/ws.js"
import { createWebSocketServer } from "../src/presentation/ws/server.js"

/**
 * The graph only has to EXIST here.
 *
 * `buildRouter(useCases)` destructures it at construction, and this test never
 * executes an RPC or a WS command — the handlers stay cold. A real graph is
 * not an option: `buildUseCases()` calls `getDatabase()`, which throws until
 * `initializeDatabase()` has run, and this suite is deliberately hermetic.
 */
const useCases = {} as unknown as UseCases

/**
 * Regression for the shutdown hang that hit EVERY production restart.
 *
 * `httpServer.close()` resolves only once the last connection is gone, and
 * both WebSocket servers are built with `noServer: true` — their `close()`
 * stops new upgrades but never ends an existing client. The old shutdown
 * awaited the HTTP close BEFORE touching either WebSocket server, so a single
 * connected dashboard guaranteed the deadlock:
 *
 *   23:49:05 "Shutting down gracefully"
 *   23:49:15 "Graceful shutdown timed out; forcing exit"   (exit 1, every time)
 *
 * `stopHttpSurface` must therefore drain with live `/ws` and `/trpc` clients
 * and an idle reverse-proxy keep-alive socket still open. If that ordering
 * regresses, the `await` below never settles and Vitest's own timeout fails
 * the test — the assertion is the drain, not a wait of our own making.
 */
describe("stopHttpSurface", () => {
	it("drains live WebSocket clients and an idle keep-alive socket", async () => {
		const server = http.createServer((_req, res) => res.end("ok"))
		createWebSocketServer(server, useCases)
		createORPCWebSocketServer(server, useCases)

		await new Promise<void>((resolve) => server.listen(0, resolve))
		const { port } = server.address() as AddressInfo

		// The shape nginx presents: an idle keep-alive socket between requests.
		const agent = new http.Agent({ keepAlive: true })
		await new Promise<void>((resolve, reject) => {
			const req = http.get({ port, path: "/", agent }, (res) => {
				res.resume()
				res.on("end", resolve)
			})
			req.on("error", reject)
		})

		const dashboardSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
		await once(dashboardSocket, "open")

		const rpcSocket = new WebSocket(`ws://127.0.0.1:${port}/trpc`)
		await once(rpcSocket, "open")

		await stopHttpSurface(server)

		expect(server.listening).toBe(false)
		for (const client of [dashboardSocket, rpcSocket]) {
			if (client.readyState !== WebSocket.CLOSED) await once(client, "close")
			expect(client.readyState).toBe(WebSocket.CLOSED)
		}

		agent.destroy()
	})
})
