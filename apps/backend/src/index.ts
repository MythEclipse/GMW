/**
 * GMW — one process.
 *
 * ## Why this file replaced two
 *
 * The service used to be three: `backend` (HTTP + oRPC + WS), `discord-gateway`
 * (selfbot capture) and `discord-gateway-worker` (the LLM loop). They were
 * separate for two reasons, and only one of them still holds.
 *
 * The split that mattered: the moderation worker holds a pg Pool and nothing
 * else. A slow or failing model can therefore never stall message capture, and
 * a worker killed mid-batch loses nothing — its claims live in Postgres with a
 * lease, so a peer or the next boot reclaims them. THAT separation is kept,
 * because it is a correctness property, not a deployment convenience.
 *
 * The split that no longer holds: the gateway and the HTTP server shared a
 * database, a Redis bus, and nine hand-duplicated `shared/` files that had
 * already drifted — the gateway's `pool.ts` had `attachPoolHandlers`, the
 * backend's did not, so a routine pg reconnect killed the HTTP process and
 * nothing killed the gateway. Three systemd units, two wrappers, two
 * `Dockerfile`s and a Redis round trip existed only to carry that duplication.
 *
 * ## What runs here
 *
 *   1. HTTP + /ws + /trpc          — the dashboard surface
 *   2. Discord selfbot capture     — the gateway's client and capture modules
 *   3. Moderation worker           — in-process, but still leased in Postgres
 *   4. Prometheus metrics          — the backend's registry plus the gateway's
 *                                   own gauges, now in one process
 *
 * The worker starts LAST and its failure is not fatal. Before the merge a dead
 * worker meant moderation silently stopped while everything looked healthy;
 * here that is logged loudly and the process keeps serving capture and the
 * dashboard, because a process that exits takes the dashboard down too, and a
 * dashboard that is down hides the fact that moderation is down.
 *
 * ## Shutdown ordering
 *
 * Reverse of startup, each step individually guarded: HTTP first so no new
 * reads start, then the Discord client so no new events are captured, then the
 * worker so in-flight verdicts are released for a peer, then the pools.
 */

import type { Server } from "node:http"
import { createChildLogger } from "@/shared/logger/index"
import { initializeDiscordGateway } from "./gateway/bootstrap.js"
import { startHttpServer } from "./http/server.js"
import { closeDrizzleDatabase } from "./shared/database/drizzle.js"

import { stopCommandBridge } from "./shared/redis/index.js"
import { startModerationWorker } from "./worker/start.js"
import { stopRedisBridge as stopEventBridge } from "./ws/redis-bridge.js"
import { closeWebSocketServer } from "./ws/server.js"

const logger = createChildLogger("gmw")

let httpServer: Server | undefined
let shuttingDown = false

/** Set by the gateway bootstrap so shutdown can destroy the Discord client. */
let destroyDiscordClient: (() => void) | undefined
/** Set by the worker bootstrap so shutdown can release its claims. */
let stopWorker: (() => Promise<void>) | undefined

async function main(): Promise<void> {
	logger.info("Starting GMW — HTTP + Discord capture + moderation")

	// 1. The dashboard surface first. If this fails there is nothing useful to
	//    serve, so the process must not come up half-alive.
	httpServer = await startHttpServer()
	logger.info("HTTP surface ready")

	// 2. Discord capture. A bad token or unreachable Discord is a real outage,
	//    but it must not take the HTTP surface with it — the dashboard is how an
	//    operator finds out why. So this failure is logged, not fatal.
	try {
		destroyDiscordClient = await initializeDiscordGateway()
	} catch (err) {
		logger.error(
			{ err },
			"Discord capture failed to start — the dashboard stays up, but no messages will be captured",
		)
	}

	// 3. The moderation worker. Same reasoning: no LLM key means no verdicts,
	//    not no dashboard.
	try {
		stopWorker = await startModerationWorker()
	} catch (err) {
		logger.error(
			{ err },
			"Moderation worker failed to start — capture continues, but no verdicts will be written",
		)
	}

	logger.info("GMW ready")
}

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return
	shuttingDown = true
	logger.info({ signal }, "Shutting down gracefully")

	// Failsafe: graceful shutdown must never hang the process forever.
	// httpServer.close() waits for ALL open connections (including lingering
	// WebSocket/keep-alive sockets), so on a stuck connection the process would
	// otherwise sit zombie and systemd (Restart=always) can never revive it.
	const forceExitTimer = setTimeout(() => {
		logger.error({ signal }, "Graceful shutdown timed out; forcing exit")
		process.exit(1)
	}, 10_000)
	forceExitTimer.unref?.()

	// Each step is guarded independently: one failure must not strand the rest.
	// The order is the reverse of startup.
	await guard("stop accepting HTTP connections", async () => {
		if (!httpServer) return
		await new Promise<void>((resolve) => {
			httpServer?.close(() => {
				logger.info("HTTP server closed")
				resolve()
			})
		})
		closeWebSocketServer()
	})

	await guard("stop Discord capture", async () => {
		destroyDiscordClient?.()
	})

	await guard("stop the moderation worker", async () => {
		await stopWorker?.()
	})

	await guard("stop Redis bridges", async () => {
		// Both bridges drop their connections synchronously before awaiting, so
		// neither can hang the shutdown when Redis is unreachable. See the comments
		// on `disconnectEventSubscriber` and `disconnectCommandClients` for why a
		// plain `quit()` is not enough on its own.
		await Promise.allSettled([
			stopEventBridge().catch((err) =>
				logger.warn({ err }, "Error stopping event bridge"),
			),
			stopCommandBridge().catch((err) =>
				logger.warn({ err }, "Error stopping command bridge"),
			),
		])
	})

	await guard("close database pool", async () => {
		// One handle now. This closed two pools — the Prisma client the dashboard
		// read through, and the Drizzle pool the gateway wrote through — both
		// against the same database, so half of that was redundant.
		await closeDrizzleDatabase().catch((err) =>
			logger.warn({ err }, "closing Drizzle pool"),
		)
	})

	clearTimeout(forceExitTimer)
	logger.info("Graceful shutdown completed")
	process.exit(0)
}

/** Run one shutdown step, logging and continuing if it throws. */
async function guard(label: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (err) {
		logger.error({ err, step: label }, "Shutdown step failed — continuing")
	}
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))

process.on("uncaughtException", (err) => {
	logger.error({ err }, "Uncaught exception")
	void shutdown("uncaughtException")
})

process.on("unhandledRejection", (reason) => {
	logger.error({ reason }, "Unhandled rejection")
	void shutdown("unhandledRejection")
})

void main().catch((err) => {
	logger.error({ err }, "Failed to start GMW")
	process.exit(1)
})
