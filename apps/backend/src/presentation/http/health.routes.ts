import { Hono } from "hono"
import { collectDefaultMetrics, register } from "prom-client"
import { healthService } from "../../application/health/health.service.js"

// Initialize default Node.js runtime metrics (event loop lag, memory, GC, etc.)
// Called once at module load, not per-request.
collectDefaultMetrics()

/**
 * Infra-only endpoints. Was an Express `Router` mounted with
 * `app.use("/api", …)`; Hono mounts a sub-app with `app.route("/api", …)`, so
 * paths inside it are written without the prefix.
 */
export function createHealthRoutes() {
	return (
		new Hono()
			// GET /api/health — 200 healthy / 503 degraded.
			//
			// `verbose` is read off the raw query string rather than a parsed object,
			// matching the Express version's `req.query.verbose === "true"` exactly:
			// only that literal string opts in.
			.get("/health", async (c) => {
				const verbose =
					new URL(c.req.url).searchParams.get("verbose") === "true"
				const result = await healthService.getHealth(verbose)
				return c.json(result, result.status === "healthy" ? 200 : 503)
			})
			// GET /api/metrics — Prometheus scrape endpoint.
			.get("/metrics", async (c) => {
				c.header("Content-Type", register.contentType)
				return c.text(await register.metrics())
			})
	)
}
