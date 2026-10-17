/**
 * Broadcast functions for WebSocket events.
 *
 * These are injected by ws/server.ts when the WebSocket server initializes.
 * Other modules call them to push real-time events to connected frontend clients.
 *
 * Usage:
 *   import { broadcastEvent } from "./broadcast.js";
 *   broadcastEvent("message_created", messageData);
 */

import { createChildLogger } from "../../infrastructure/logger/index.js"

const logger = createChildLogger("broadcast")

type BroadcastFn = (type: string, data: unknown) => void

let _broadcast: BroadcastFn | null = null

/**
 * Inject the broadcast function from the WebSocket server initializer.
 * Must be called once during server startup before any broadcast is used.
 *
 * Binary broadcasting used to be injected alongside this one, but nothing ever
 * called it: `broadcastEvent` is the only entry point any module uses. A second
 * injected function that no caller reaches is a permanent `null` behind an
 * optional call — it reads as a live transport and silently drops nothing only
 * because nothing was ever sent. Removed rather than wired up; voice PCM over
 * `/ws` is gone with the gateway merge, and the dashboard takes JSON only.
 */
export function setBroadcastFunctions(bf: BroadcastFn): void {
	_broadcast = bf
	logger.info("Broadcast functions initialized")
}

/**
 * Broadcast a JSON event to all connected WebSocket clients.
 */
export function broadcastEvent(type: string, data: unknown): void {
	logger.debug({ event: type }, "Broadcasting event")
	_broadcast?.(type, data)
}
