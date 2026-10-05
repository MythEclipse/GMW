import Redis from "ioredis"
import { config } from "../shared/config/index.js"
import { DISCORD_CHANNEL_TO_WS_EVENT } from "../shared/index.js"
import { createChildLogger } from "../shared/logger/index.js"
import { broadcastEvent } from "./broadcast.js"

const logger = createChildLogger("ws.redis-bridge")

/** Channels we subscribe to = all keys in DISCORD_CHANNEL_TO_WS_EVENT */
const SUBSCRIPTION_CHANNELS = Object.keys(DISCORD_CHANNEL_TO_WS_EVENT)

/** Shape of the DiscordGatewayEvent envelope published by the gateway. */
interface GatewayEnvelope {
	type?: string
	data?: unknown
	timestamp?: number
	source?: string
}

let subscriber: Redis | null = null

function createSubscriber(): Redis {
	return new Redis(config.REDIS_URL, { keyPrefix: "" })
}

function handleSubscriptionMessage(channel: string, message: string): void {
	const eventType = DISCORD_CHANNEL_TO_WS_EVENT[channel]
	if (!eventType) {
		logger.warn({ channel }, "Received message for unmapped Redis channel")
		return
	}

	let envelope: GatewayEnvelope
	try {
		envelope = JSON.parse(message) as GatewayEnvelope
	} catch (err) {
		logger.error({ channel, err }, "Failed to parse Redis message as JSON")
		return
	}

	// Unwrap DiscordGatewayEvent envelope — the gateway publishes:
	// { type, data: <actual payload>, timestamp, source }
	// We only want <actual payload>, not the full envelope.
	const data = envelope.data !== undefined ? envelope.data : envelope

	logger.debug({ channel, eventType }, "Broadcasting Redis event")
	broadcastEvent(eventType, data)
}

export async function startRedisBridge(): Promise<void> {
	if (!config.REDIS_URL) {
		logger.info("Redis not configured, skipping Redis bridge")
		return
	}

	try {
		subscriber = createSubscriber()

		subscriber.on("error", (err: Error) => {
			logger.error({ err }, "Redis subscriber error")
		})

		subscriber.on("connect", () => {
			logger.info("Redis subscriber connected")
		})

		subscriber.on("reconnecting", () => {
			logger.warn("Redis subscriber reconnecting…")
		})

		subscriber.on("close", () => {
			logger.warn("Redis subscriber connection closed")
		})

		subscriber.on("message", handleSubscriptionMessage)

		await subscriber.ping()
		logger.info("Redis ping OK")

		const channels = SUBSCRIPTION_CHANNELS
		await subscriber.subscribe(...channels)
		logger.info({ channels }, "Subscribed to Redis channels")

		logger.info("Redis bridge started")
	} catch (err) {
		logger.error({ err }, "Failed to start Redis bridge")
		throw err
	}
}

export async function stopRedisBridge(): Promise<void> {
	if (!subscriber) {
		logger.debug("Redis bridge not running, nothing to stop")
		return
	}

	// `quit()` below only settles once the server ACKNOWLEDGES it. With Redis
	// unreachable — precisely during a Redis restart — it never settles, so this
	// await hangs until the process's failsafe timer kills the process, and
	// ioredis's reconnect timer keeps the event loop busy the whole time. So the
	// connection is not asked to quit at all: `disconnectEventSubscriber()` drops
	// it immediately, which is what "stop" has to mean when there is no server
	// left to be polite to.
	//
	// Verified against a probe process with REDIS_URL on a closed port: before
	// this, shutdown never logged "completed" and always hit the 10s failsafe.
	const client = subscriber
	disconnectEventSubscriber()

	// If the socket is up, close it cleanly so Redis drops the subscriber.
	if (client.status === "ready") {
		try {
			await client.quit()
			logger.info("Redis bridge stopped")
		} catch (err) {
			logger.error({ err }, "Error stopping Redis bridge")
			client.disconnect()
		}
	} else {
		logger.info("Redis bridge disconnected without quit (server unreachable)")
	}
}

/**
 * Drop the subscriber connection immediately, without waiting for the server.
 *
 * Separate from `stopRedisBridge` because `quit()` only settles once the server
 * ACKNOWLEDGES it. With Redis unreachable — precisely during a Redis restart —
 * it never settles, so a shutdown that awaits it hangs until the process's
 * failsafe timer kills it, and ioredis's reconnect timer keeps the event loop
 * busy the whole time. This is the synchronous teardown that guarantees neither.
 */
export function disconnectEventSubscriber(): void {
	if (!subscriber) return
	subscriber.disconnect()
	subscriber = null
	logger.info("Redis event subscriber disconnected")
}
