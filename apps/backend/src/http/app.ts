import { onError } from "@orpc/server"
import { RPCHandler } from "@orpc/server/fetch"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { secureHeaders } from "hono/secure-headers"
import { createChildLogger } from "@/shared/logger/index"
import { createHealthRoutes } from "../modules/health/index.js"
import { appRouter } from "../orpc/router"

// Auth removed — dashboard is public.
// All data APIs (dashboard, messages, moderation, media, voice, recordings,
// analysis, chatbot, config, ui-state) now flow over oRPC, served on TWO
// transports sharing the /trpc path:
//   - WebSocket (browser live RPCs)  — see orpc/ws.ts
//   - HTTP POST   (browser, post-P4) — handled below
// Only infra endpoints (health, prometheus metrics) remain plain HTTP.
//
// NOT `hono/ws`'s upgradeWebSocket. Both WebSocket servers here register their
// own `server.on("upgrade")` listener on a bare node:http Server and route by
// URL; a middleware-based upgrade would fight both of them. `serve()` in
// ./server.ts returns that same Server, so those listeners attach unchanged —
// see src/http/server.ts and the note in src/orpc/ws.ts.

const logger = createChildLogger("http.app")

export function createHttpApp(): Hono {
	const app = new Hono()

	// Security headers. CSP stays OFF, matching the Express version verbatim:
	// the SPA ships inline styles, and turning it on would need a nonce threaded
	// through index.html — a separate change with its own testing.
	//
	// Hono's equivalent is `secureHeaders`, which is Helmet's behaviour ported
	// onto the WHATWG Headers API. It is Helmet minus the CSP helmet-wearing,
	// which is the one piece that is disabled here anyway.
	app.use(secureHeaders())

	// No global body parser: Hono parses JSON per-route and oRPC's handler reads
	// the request stream itself.
	//
	// No `compress()` — nginx already sets `gzip on` with `gzip_min_length 256`.
	// No `cors()` — it was absent under Express too, Vite proxies same-origin in
	// dev, and the dashboard has no auth, so adding it would widen exposure.

	// Request logging. Same rule as before: failures only, and never the
	// well-known probes or the favicon.
	app.use(async (c, next) => {
		if (c.req.path.startsWith("/api/")) {
			c.header("Cache-Control", "no-store")
		}
		await next()
		if (c.req.path.startsWith("/.well-known/")) return
		if (c.req.path === "/favicon.ico") return
		if (c.res.status >= 400) {
			logger.warn(
				{
					method: c.req.method,
					url: c.req.path,
					statusCode: c.res.status,
				},
				"HTTP request failed",
			)
		}
	})

	// Infra-only HTTP endpoints.
	app.route("/api", createHealthRoutes())

	// oRPC over HTTP. The same appRouter the browser reaches over the /trpc
	// WebSocket. `app.all` replaces the Express version's manual
	// `req.path.startsWith("/trpc")` gate AND its `matched` fallthrough: in Hono
	// the handler either matched a route or it did not, and an unmatched /trpc
	// path falls through to notFound below. That removes both Express-model
	// artifacts — the `next()` dance and the `res.headersSent` guard — instead
	// of porting them.
	const orpcHandler = new RPCHandler(appRouter, {
		interceptors: [onError((error) => logger.error({ error }, "oRPC error"))],
	})

	// oRPC's FETCH handler takes and returns a web-standard Request/Response, which
	// is exactly what Hono speaks — no node IncomingMessage/ServerResponse
	// bridging, and no "Context is not finalized" problem, because the handler
	// returns a Response for Hono to send like any other.
	//
	// This replaces the Express version's manual `req.path.startsWith("/trpc")`
	// gate AND its `matched` fallthrough. `app.all("/trpc/*")` does the matching,
	// and an unmatched procedure falls through to notFound — the same outcome
	// the old `next()` produced, minus the two Express-model artifacts (the
	// `next()` dance and the `res.headersSent` guard).
	app.all("/trpc/*", async (c) => {
		// Returns `{matched, response}` rather than a bare Response. On a miss
		// there is no response to send, so this unwraps to Hono's notFound —
		// which is what the Express version's `next()` reached.
		const { matched, response } = await orpcHandler.handle(c.req.raw, {
			prefix: "/trpc",
			context: {},
		})
		if (!matched) {
			throw new HTTPException(404)
		}
		return response
	})

	app.notFound((c) =>
		c.json(
			{
				error: "NOT_FOUND",
				message:
					"Endpoint not found — data APIs are served over /trpc (WebSocket/HTTP)",
			},
			404,
		),
	)

	return app
}
